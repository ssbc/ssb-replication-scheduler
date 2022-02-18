// SPDX-FileCopyrightText: 2021 Andre 'Staltz' Medeiros
//
// SPDX-License-Identifier: LGPL-3.0-only

const pull = require('pull-stream')
const debug = require('debug')('ssb:replication-scheduler')
const bendyButtEBTFormat = require('ssb-ebt/formats/bendy-butt')
const indexedEBTFormat = require('ssb-ebt/formats/indexed')
const Template = require('./template')
const MetafeedFinder = require('./metafeed-finder')

const DEFAULT_PERIOD = 150 // ms
const BATCH_LIMIT = 8

module.exports = class RequestManager {
  constructor(ssb, opts) {
    this._ssb = ssb
    this._opts = opts
    this._metafeedFinder = new MetafeedFinder(ssb, opts, BATCH_LIMIT)
    this._period =
      typeof opts.debouncePeriod === 'number'
        ? opts.debouncePeriod
        : DEFAULT_PERIOD
    this._requestables = new Map() // feedId => hops
    this._requested = new Map() // feedId => hops
    this._requestedPartially = new Map() // mainFeedId => hops
    this._unrequested = new Map() // feedId => hops when it used to be requested
    this._blocked = new Map() // feedId => hops before it was blocked
    this._tombstoned = new Set() // feedIds
    this._flushing = false
    this._wantsMoreFlushing = false
    this._latestAdd = 0
    this._timer = null
    this._oldBranchDrainer = null
    this._liveBranchDrainer = null
    this._tombstonedBranchDrainer = null
    this._liveFinderDrainer = null
    this._hasCloseHook = false
    this._templates = this._setupTemplates(this._opts.partialReplication)

    // If at least one hops template is configured, then setup ssb-ebt
    if (this._templates) {
      this._ssb.ebt.registerFormat(bendyButtEBTFormat)
      if (this._someTemplate((t) => t.hasIndexLeaf())) {
        this._ssb.ebt.registerFormat(indexedEBTFormat)
      }
    }
  }

  add(mainFeedId, hops) {
    if (hops === -1) return this._block(mainFeedId)
    if (hops < -1) return this._unrequest(mainFeedId)

    const sameHops = hops === this._getCurrentHops(mainFeedId)
    if (sameHops && this._requestables.has(mainFeedId)) return
    if (sameHops && this._requested.has(mainFeedId)) return
    if (sameHops && this._requestedPartially.has(mainFeedId)) return

    if (!sameHops) {
      this._requestables.delete(mainFeedId)
      this._requested.delete(mainFeedId)
      this._requestedPartially.delete(mainFeedId)
      this._unrequested.delete(mainFeedId)
      this._blocked.delete(mainFeedId)

      this._requestables.set(mainFeedId, hops)
      this._latestAdd = Date.now()
      this._scheduleDebouncedFlush()
    }
  }

  reconfigure(opts) {
    this._opts = { ...this._opts, ...opts }
    this._period =
      typeof opts.debouncePeriod === 'number'
        ? opts.debouncePeriod
        : this._period
    this._templates = this._setupTemplates(this._opts.partialReplication)
    for (const [feedId, hops] of this._requested) {
      this._requestables.set(feedId, hops)
      this._requested.delete(feedId)
    }
    for (const [mainFeedId, hops] of this._requestedPartially) {
      this._requestables.set(mainFeedId, hops)
      this._requestedPartially.delete(mainFeedId)
    }
    // Refresh only the old branches stream drainer, not the live streams
    if (this._oldBranchDrainer) this._oldBranchDrainer.abort()
    this._oldBranchDrainer = null
    this._flush()
  }

  _setupTemplates(optsPartialReplication) {
    if (!optsPartialReplication) return null
    if (Object.values(optsPartialReplication).every((t) => !t)) return null
    const hopsArr = Object.keys(optsPartialReplication)
      .map(Number)
      .filter((x) => x >= 0)
    const templates = new Map()
    for (const hops of hopsArr) {
      if (optsPartialReplication[hops]) {
        templates.set(hops, new Template(optsPartialReplication[hops]))
      } else {
        templates.set(hops, null)
      }
    }
    return templates
  }

  _someTemplate(fn) {
    if (!this._templates) return false
    return [...this._templates.values()].filter((t) => !!t).some(fn)
  }

  _findTemplateForHops(hops) {
    if (!this._templates) return null
    const templateKeys = [...this._templates.keys()]
    const eligibleHopsArr = templateKeys.filter((h) => h >= hops)
    const pickedHops =
      eligibleHopsArr.length > 0
        ? Math.min(...eligibleHopsArr)
        : Math.max(...templateKeys)
    return this._templates.get(pickedHops)
  }

  _setupCloseHook() {
    this._hasCloseHook = true
    const that = this
    this._ssb.close.hook(function (fn, args) {
      if (that._oldBranchDrainer) that._oldBranchDrainer.abort()
      if (that._liveBranchDrainer) that._liveBranchDrainer.abort()
      if (that._tombstonedBranchDrainer) that._tombstonedBranchDrainer.abort()
      if (that._liveFinderDrainer) that._liveFinderDrainer.abort()
      fn.apply(this, args)
    })
  }

  _getCurrentHops(feedId) {
    let h
    h = this._requestables.get(feedId)
    if (typeof h === 'number') return h
    h = this._requested.get(feedId)
    if (typeof h === 'number') return h
    h = this._requestedPartially.get(feedId)
    if (typeof h === 'number') return h
    return null
  }

  _setupStreamDrainers() {
    if (!this._hasCloseHook) this._setupCloseHook()

    if (!this._oldBranchDrainer) {
      const opts = { tombstoned: false, old: true, live: false }
      pull(
        this._ssb.metafeeds.branchStream(opts),
        (this._oldBranchDrainer = pull.drain((branch) => {
          this._handleBranch(branch)
        }))
      )
    }

    if (!this._liveBranchDrainer) {
      const opts = { tombstoned: false, old: false, live: true }
      pull(
        this._ssb.metafeeds.branchStream(opts),
        (this._liveBranchDrainer = pull.drain((branch) => {
          this._handleBranch(branch)
        }))
      )
    }

    if (!this._tombstonedBranchDrainer) {
      const opts = { tombstoned: true, old: true, live: true }
      pull(
        this._ssb.metafeeds.branchStream(opts),
        (this._tombstonedBranchDrainer = pull.drain((branch) => {
          const [leafId] = branch[branch.length - 1]
          this._tombstone(leafId, true)
        }))
      )
    }

    // Automatically switch to partial replication if (while replicating fully)
    // we bump into a metafeed/announce msg
    if (!this._liveFinderDrainer) {
      pull(
        this._metafeedFinder.liveStream(),
        (this._liveFinderDrainer = pull.drain(([mainFeedId, metaFeedId]) => {
          if (
            this._requested.has(mainFeedId) &&
            !this._requestedPartially.has(metaFeedId)
          ) {
            debug(
              'switch from full replication to partial replication for %s',
              mainFeedId
            )
            const hops = this._requested.get(mainFeedId)
            this._unrequest(mainFeedId)
            this._requestables.set(mainFeedId, hops)
            this._requestPartially(mainFeedId)
          }
        }))
      )
    }
  }

  _matchBranchWith(hops, branch, mainFeedId) {
    const template = this._findTemplateForHops(hops)
    if (!template) return
    return template.matchBranch(branch, mainFeedId)
  }

  _handleBranch(branch) {
    const root = branch[0]
    const leaf = branch[branch.length - 1]
    const metaFeedId = root[0]
    const mainFeedId = this._metafeedFinder.getInverse(metaFeedId)
    if (!mainFeedId) return
    const subfeed = leaf[0]

    if (this._requestedPartially.has(mainFeedId)) {
      const hops = this._requestedPartially.get(mainFeedId)
      const matchedNode = this._matchBranchWith(hops, branch, mainFeedId)
      if (!matchedNode) return
      this._request(subfeed, hops, matchedNode['$format'])
      return
    }

    // Unrequest subfeed if main feed was unrequested
    if (this._unrequested.has(mainFeedId)) {
      const prevHops = this._unrequested.get(mainFeedId)
      if (prevHops === null) {
        this._unrequest(subfeed)
        return
      }
      const matchedNode = this._matchBranchWith(prevHops, branch, mainFeedId)
      if (!matchedNode) return
      this._unrequest(subfeed, matchedNode['$format'])
      return
    }

    // Block subfeed if main feed was blocked
    if (this._blocked.has(mainFeedId)) {
      const prevHops = this._blocked.get(mainFeedId)
      if (prevHops === null) {
        this._block(subfeed)
        return
      }
      const matchedNode = this._matchBranchWith(prevHops, branch, mainFeedId)
      if (!matchedNode) return
      this._block(subfeed, matchedNode['$format'])
      return
    }
  }

  _fetchAndRequestMetafeed(mainFeedId, hops) {
    this._metafeedFinder.fetch(mainFeedId, (err, metafeedId) => {
      if (err) {
        console.error(err)
      } else if (!metafeedId) {
        console.error('cannot partially replicate ' + mainFeedId)
      } else {
        this._request(metafeedId, hops)
      }
    })
  }

  _requestPartially(mainFeedId) {
    if (this._requestedPartially.has(mainFeedId)) return
    if (!this._requestables.has(mainFeedId)) return
    debug('will process %s for partial replication', mainFeedId)

    const hops = this._getCurrentHops(mainFeedId)
    this._requestedPartially.set(mainFeedId, hops)
    this._requestables.delete(mainFeedId)

    // We may already have the meta feed, so continue replicating
    const root = this._metafeedFinder.get(mainFeedId)
    if (root) {
      let branchesFound = false
      const opts = { root, tombstoned: false, old: true, live: false }
      pull(
        this._ssb.metafeeds.branchStream(opts),
        pull.drain(
          (branch) => {
            branchesFound = true
            this._handleBranch(branch)
          },
          () => {
            if (branchesFound === false) {
              this._fetchAndRequestMetafeed(mainFeedId, hops)
            }
          }
        )
      )
    }
    // Fetch metafeedId for this (main) feedId for the first time
    else {
      this._fetchAndRequestMetafeed(mainFeedId, hops)
    }
  }

  _request(feedId, hops = null, ebtFormat = undefined) {
    if (this._requested.has(feedId)) return
    debug('will replicate %s', feedId)

    if (this._requestables.has(feedId)) {
      hops = this._requestables.get(feedId)
      this._requestables.delete(feedId)
    }
    this._requested.set(feedId, hops)
    this._ssb.ebt.block(this._ssb.id, feedId, false, ebtFormat)
    this._ssb.ebt.request(feedId, true, ebtFormat)
  }

  _unrequest(feedId, ebtFormat = undefined) {
    if (this._unrequested.has(feedId)) return
    debug('will stop replicating %s', feedId)

    const hops = this._getCurrentHops(feedId)
    this._requestables.delete(feedId)
    this._requested.delete(feedId)
    this._requestedPartially.delete(feedId)
    this._unrequested.set(feedId, hops)
    this._ssb.ebt.request(feedId, false, ebtFormat)
    this._ssb.ebt.block(this._ssb.id, feedId, false, ebtFormat)

    if (this._templates) {
      // Weave through all of the subfeeds and unrequest them too
      const root = this._metafeedFinder.get(feedId) || feedId
      pull(
        this._ssb.metafeeds.branchStream({ root, old: true, live: false }),
        pull.drain((branch) => {
          this._handleBranch(branch)
        })
      )
    }
  }

  _block(feedId, ebtFormat = undefined) {
    if (this._blocked.has(feedId)) return
    debug('will block replication of %s', feedId)

    const hops = this._getCurrentHops(feedId)
    this._requestables.delete(feedId)
    this._requested.delete(feedId)
    this._requestedPartially.delete(feedId)
    this._blocked.set(feedId, hops)
    this._ssb.ebt.request(feedId, false, ebtFormat)
    this._ssb.ebt.block(this._ssb.id, feedId, true, ebtFormat)

    if (this._templates) {
      // Weave through all of the subfeeds and block them too
      const root = this._metafeedFinder.get(feedId) || feedId
      pull(
        this._ssb.metafeeds.branchStream({ root, old: true, live: false }),
        pull.drain((branch) => {
          this._handleBranch(branch)
        })
      )
    }
  }

  _tombstone(feedId, shouldWeave = false) {
    if (this._tombstoned.has(feedId)) return
    debug('will stop replicating tombstoned %s', feedId)

    this._requestables.delete(feedId)
    this._requested.delete(feedId)
    this._requestedPartially.delete(feedId)
    this._blocked.delete(feedId)
    this._tombstoned.add(feedId)
    this._ssb.ebt.request(feedId, false)

    // Weave through all of the subfeeds and tombstone them too
    if (shouldWeave) {
      const opts = { root: feedId, tombstoned: null, old: true, live: false }
      pull(
        this._ssb.metafeeds.branchStream(opts),
        pull.drain((branch) => {
          const [leafId] = branch[branch.length - 1]
          this._tombstone(leafId, false)
        })
      )
    }
  }

  _supportsPartialReplication(mainFeedId, cb) {
    this._metafeedFinder.fetch(mainFeedId, (err, metafeedId) => {
      if (err) cb(err)
      else cb(null, !!metafeedId)
    })
  }

  _scheduleDebouncedFlush() {
    if (this._flushing) {
      this._wantsMoreFlushing = true
      return
    }
    this._wantsMoreFlushing = false

    if (this._period === 0) {
      this._flush()
      return
    }

    if (this._timer) return // Timer is already enabled
    this._timer = setInterval(() => {
      // Turn off the timer if there is nothing to flush
      if (this._requestables.size === 0) {
        clearInterval(this._timer)
        this._timer = null
      }
      // Flush if enough time has passed
      else if (Date.now() - this._latestAdd > this._period) {
        clearInterval(this._timer)
        this._timer = null
        this._flush()
      }
    }, this._period * 0.5)
    if (this._timer.unref) this._timer.unref()
  }

  _flush() {
    this._flushing = true
    pull(
      pull.values([...this._requestables.entries()]),
      pull.asyncMap(([feedId, hops], cb) => {
        const template = this._findTemplateForHops(hops)
        if (!template) return cb(null, [feedId, false])

        this._supportsPartialReplication(feedId, (err, supports) => {
          if (err) cb(err)
          else cb(null, [feedId, supports])
        })
      }),
      pull.drain(
        ([feedId, supportsPartialReplication]) => {
          if (supportsPartialReplication) {
            this._requestPartially(feedId)
          } else {
            this._request(feedId)
          }
        },
        (err) => {
          this._flushing = false
          if (err) console.error(err)
          if (this._templates) this._setupStreamDrainers()
          if (this._wantsMoreFlushing) {
            this._scheduleDebouncedFlush()
          }
        }
      )
    )
  }
}

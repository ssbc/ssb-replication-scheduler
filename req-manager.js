const pull = require('pull-stream')
const debug = require('debug')('ssb:replication-scheduler')
const bendyButtEBTFormat = require('ssb-ebt/formats/bendy-butt')
const indexedEBTFormat = require('ssb-ebt/formats/indexed')
const Template = require('./template')

const DEFAULT_PERIOD = 150 // ms

module.exports = class RequestManager {
  constructor(ssb, opts, metafeedFinder) {
    this._ssb = ssb
    this._opts = opts
    this._metafeedFinder = metafeedFinder
    this._period =
      typeof opts.debouncePeriod === 'number'
        ? opts.debouncePeriod
        : DEFAULT_PERIOD
    this._requestables = new Map() // feedId => hops
    this._requested = new Map() // feedId => hops
    this._requestedPartially = new Map() // feedId => hops
    this._unrequested = new Map() // feedId => hops when it used to be requested
    this._blocked = new Map() // feedId => hops before it was blocked
    // FIXME: how should we handle tombstoning?
    this._flushing = false
    this._wantsMoreFlushing = false
    this._latestAdd = 0
    this._timer = null
    this._oldBranchDrainer = null
    this._liveBranchDrainer = null
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

  add(feedId, hops) {
    if (hops === -1) return this._block(feedId)
    if (hops < -1) return this._unrequest(feedId)

    const sameHops = hops === this._getCurrentHops(feedId)
    if (sameHops && this._requestables.has(feedId)) return
    if (sameHops && this._requested.has(feedId)) return
    if (sameHops && this._requestedPartially.has(feedId)) return

    if (!sameHops) {
      this._requestables.delete(feedId)
      this._requested.delete(feedId)
      this._requestedPartially.delete(feedId)
      this._unrequested.delete(feedId)
      this._blocked.delete(feedId)

      this._requestables.set(feedId, hops)
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
    for (const [feedId, hops] of this._requestedPartially) {
      this._requestables.set(feedId, hops)
      this._requestedPartially.delete(feedId)
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
    const eligibleHopsArr = [...this._templates.keys()].filter((h) => h >= hops)
    const pickedHops = Math.min(...eligibleHopsArr)
    return this._templates.get(pickedHops)
  }

  _setupCloseHook() {
    this._hasCloseHook = true
    const that = this
    this._ssb.close.hook(function (fn, args) {
      if (that._oldBranchDrainer) that._oldBranchDrainer.abort()
      if (that._liveBranchDrainer) that._liveBranchDrainer.abort()
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
      pull(
        this._ssb.metafeeds.branchStream({ old: true, live: false }),
        (this._oldBranchDrainer = pull.drain((branch) => {
          const metaFeedId = branch[0][0]
          const mainFeedId = this._metafeedFinder.getInverse(metaFeedId)
          this._handleBranch(branch, mainFeedId)
        }))
      )
    }

    if (!this._liveBranchDrainer) {
      pull(
        this._ssb.metafeeds.branchStream({ old: false, live: true }),
        (this._liveBranchDrainer = pull.drain((branch) => {
          const metaFeedId = branch[0][0]
          const mainFeedId = this._metafeedFinder.getInverse(metaFeedId)
          this._handleBranch(branch, mainFeedId)
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

    // FIXME: pull tombstoneBranchStream and do ssb.ebt.request(tombId, false)
  }

  _matchBranchWith(hops, branch, mainFeedId) {
    const template = this._findTemplateForHops(hops)
    if (!template) return
    return template.matchBranch(branch, mainFeedId)
  }

  _handleBranch(branch, mainFeedId) {
    const last = branch[branch.length - 1]
    const subfeed = last[0]

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

  _fetchAndRequestMetafeed(feedId, hops) {
    this._metafeedFinder.fetch(feedId, (err, metafeedId) => {
      if (err) {
        console.error(err)
      } else if (!metafeedId) {
        console.error('cannot partially replicate ' + feedId)
      } else {
        this._request(metafeedId, hops)
      }
    })
  }

  _requestPartially(feedId) {
    if (this._requestedPartially.has(feedId)) return
    if (!this._requestables.has(feedId)) return
    debug('will process %s for partial replication', feedId)

    const hops = this._getCurrentHops(feedId)
    this._requestedPartially.set(feedId, hops)
    this._requestables.delete(feedId)

    // We may already have the meta feed, so continue replicating
    const root = this._metafeedFinder.get(feedId)
    if (root) {
      let branchesFound = false
      pull(
        this._ssb.metafeeds.branchStream({ root, old: true, live: false }),
        pull.drain(
          (branch) => {
            branchesFound = true
            this._handleBranch(branch, feedId)
          },
          () => {
            if (branchesFound === false) {
              this._fetchAndRequestMetafeed(feedId, hops)
            }
          }
        )
      )
    }
    // Fetch metafeedId for this (main) feedId for the first time
    else {
      this._fetchAndRequestMetafeed(feedId, hops)
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

    // Weave through all of the subfeeds and unrequest them too
    const root = this._metafeedFinder.get(feedId)
    if (root) {
      pull(
        this._ssb.metafeeds.branchStream({ root, old: true, live: false }),
        pull.drain((branch) => {
          this._handleBranch(branch, feedId)
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

    // Weave through all of the subfeeds and block them too
    const root = this._metafeedFinder.get(feedId)
    if (root) {
      pull(
        this._ssb.metafeeds.branchStream({ root, old: true, live: false }),
        pull.drain((branch) => {
          this._handleBranch(branch, feedId)
        })
      )
    }
  }

  _supportsPartialReplication(feedId, cb) {
    this._metafeedFinder.fetch(feedId, (err, metafeedId) => {
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

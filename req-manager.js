// SPDX-FileCopyrightText: 2021 Andre 'Staltz' Medeiros
//
// SPDX-License-Identifier: LGPL-3.0-only

const pull = require('pull-stream')
const cat = require('pull-cat')
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
      // debouncePeriod basically controls how often will we trigger
      // ssb.ebt.request() calls. We trigger those when the
      // requestManager.add() has "calmed down", i.e. after debouncePeriod
      // milliseconds have passed in which add() was not called.
      typeof opts.debouncePeriod === 'number'
        ? opts.debouncePeriod
        : DEFAULT_PERIOD
    this._requestableMains = new Map() // mainFeedId => hops
    this._requestableRoots = new Map() // rootFeedId => category
    this._requested = new Map() // feedId => hops
    this._requestedTreeFromMain = new Map() // mainFeedId => hops
    this._requestedTreeFromRoot = new Map() // rootFeedId => category
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
    this._myGroupSecrets = new Set() // base64 encoded

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
    if (sameHops && this._requestableMains.has(mainFeedId)) return
    if (sameHops && this._requested.has(mainFeedId)) return
    if (sameHops && this._requestedTreeFromMain.has(mainFeedId)) return

    if (!sameHops) {
      this._requestableMains.delete(mainFeedId)
      this._requested.delete(mainFeedId)
      this._requestedTreeFromMain.delete(mainFeedId)
      this._unrequested.delete(mainFeedId)
      this._blocked.delete(mainFeedId)

      this._requestableMains.set(mainFeedId, hops)
      this._latestAdd = Date.now()
      this._scheduleDebouncedFlush()
    }
  }

  addGroupMember(groupMemberId, groupSecret) {
    //console.log('groupMember', { groupMemberId, groupSecret })
    this._myGroupSecrets.add(groupSecret.toString('base64'))

    this._requestableRoots.set(groupMemberId, 'group')
    this._latestAdd = Date.now()
    this._scheduleDebouncedFlush()

    //this._requestables.delete(mainFeedId)
    //this._requested.delete(mainFeedId)
    //this._requestedPartially.delete(mainFeedId)
    //this._unrequested.delete(mainFeedId)
    //this._blocked.delete(mainFeedId)

    //this._requestables.set(mainFeedId, hops)
    //this._latestAdd = Date.now()
    //this._scheduleDebouncedFlush()
  }

  reconfigure(opts) {
    this._opts = { ...this._opts, ...opts }
    this._period =
      typeof opts.debouncePeriod === 'number'
        ? opts.debouncePeriod
        : this._period
    this._templates = this._setupTemplates(this._opts.partialReplication)
    for (const [feedId, hops] of this._requested) {
      this._requestableMains.set(feedId, hops)
      this._requested.delete(feedId)
    }
    for (const [mainFeedId, hops] of this._requestedTreeFromMain) {
      this._requestableMains.set(mainFeedId, hops)
      this._requestedTreeFromMain.delete(mainFeedId)
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
    const group = optsPartialReplication.group
    const templates = new Map()
    for (const hops of hopsArr) {
      if (Array.isArray(optsPartialReplication[hops])) {
        templates.set(hops, new Template(optsPartialReplication[hops]))
      } else {
        templates.set(hops, null)
      }
    }
    if (group) {
      templates.set('group', new Template(group))
    }
    return templates
  }

  _someTemplate(fn) {
    if (!this._templates) return false
    return [...this._templates.values()].filter((t) => !!t).some(fn)
  }

  /**
   * @param {number | "group"} category hops or groups
   */
  _findTemplateForCategory(category) {
    if (!this._templates) return null
    if (category === 'group') return this._templates.get('group')
    const hops = category
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
    h = this._requestableMains.get(feedId)
    if (typeof h === 'number') return h
    h = this._requested.get(feedId)
    if (typeof h === 'number') return h
    h = this._requestedTreeFromMain.get(feedId)
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
          const leaf = branch[branch.length - 1]
          this._tombstone(leaf.id, true)
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
            !this._requestedTreeFromMain.has(metaFeedId)
          ) {
            debug(
              'switch from full replication to partial replication for %s',
              mainFeedId
            )
            const hops = this._requested.get(mainFeedId)
            this._unrequest(mainFeedId)
            this._requestableMains.set(mainFeedId, hops)
            this._requestTreeFromMain(mainFeedId)
          }
        }))
      )
    }
  }

  /**
   * @param {number | "group"} category hops or groups
   */
  _matchBranchWith(category, branch, mainFeedId = null) {
    const template = this._findTemplateForCategory(category)
    if (!template) return
    return template.matchBranch(branch, mainFeedId, this._myGroupSecrets)
  }

  /**
   * Validation according to metafeeds tree structure v1
   */
  _isValidBranch(branch) {
    if (!Array.isArray(branch)) return false
    if (branch.length <= 0 || branch.length > 4) return false
    const [root, v1, shard] = branch
    if (root.purpose !== 'root') return false
    if (branch.length === 1) return true
    if (v1.purpose !== 'v1') return false
    if (branch.length === 2) return true
    if (shard.purpose.length !== 1) return false
    return true
  }

  _handleBranch(branch) {
    const root = branch[0]
    const leaf = branch[branch.length - 1]
    // this might be null but that's fine
    const mainFeedId = this._metafeedFinder.getInverse(root.id)
    const feedId = mainFeedId || root.id
    if (!this._isValidBranch(branch)) return

    if (this._requestedTreeFromMain.has(mainFeedId)) {
      const hops = this._requestedTreeFromMain.get(mainFeedId)
      const isMatch = this._matchBranchWith(hops, branch, mainFeedId)
      if (!isMatch) return
      this._request(leaf.id, hops)
      return
    }

    if (this._requestedTreeFromRoot.has(root.id)) {
      const isMatch = this._matchBranchWith('group', branch)
      if (!isMatch) return
      this._request(leaf.id)
      return
    }

    // Unrequest leaf feed if feed was unrequested
    if (this._unrequested.has(feedId)) {
      const prevCategory = this._unrequested.get(feedId)
      if (prevCategory === null) {
        this._unrequest(leaf.id)
        return
      }
      const isMatch = this._matchBranchWith(prevCategory, branch, mainFeedId)
      if (!isMatch) return
      this._unrequest(leaf.id)
      return
    }

    // Block leaf feed if main feed was blocked
    if (this._blocked.has(mainFeedId)) {
      const prevHops = this._blocked.get(mainFeedId)
      if (prevHops === null) {
        this._block(leaf.id)
        return
      }
      const isMatch = this._matchBranchWith(prevHops, branch, mainFeedId)
      if (!isMatch) return
      this._block(leaf.id)
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

  _requestTreeFromMain(mainFeedId) {
    if (this._requestedTreeFromMain.has(mainFeedId)) return
    if (!this._requestableMains.has(mainFeedId)) return
    debug('will process metafeed tree for %s', mainFeedId)

    const hops = this._getCurrentHops(mainFeedId)
    this._requestedTreeFromMain.set(mainFeedId, hops)
    this._requestableMains.delete(mainFeedId)

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

  _requestTreeFromRoot(rootFeedId) {
    //TODO: only do this for ones we haven't done it already for

    debug('will process metafeed tree under %s', rootFeedId)

    this._requestedTreeFromRoot.set(rootFeedId, 'group')

    //console.log('will request', rootFeedId)
    const opts = { root: rootFeedId, tombstoned: false, old: true, live: false }
    pull(
      this._ssb.metafeeds.branchStream(opts),
      pull.drain((branch) => {
        //if (branch.length === 3) console.log('a branch', branch)
        this._handleBranch(branch)
      })
    )
  }

  _request(feedId, hops = null) {
    if (this._requested.has(feedId)) return
    debug('will replicate %s', feedId)

    if (this._requestableMains.has(feedId)) {
      hops = this._requestableMains.get(feedId)
      this._requestableMains.delete(feedId)
    }
    this._requested.set(feedId, hops)
    this._ssb.ebt.block(this._ssb.id, feedId, false)
    this._ssb.ebt.request(feedId, true)
  }

  _unrequest(feedId) {
    if (this._unrequested.has(feedId)) return
    debug('will stop replicating %s', feedId)

    const hops = this._getCurrentHops(feedId)
    this._requestableMains.delete(feedId)
    this._requested.delete(feedId)
    this._requestedTreeFromMain.delete(feedId)
    this._unrequested.set(feedId, hops)
    this._ssb.ebt.request(feedId, false)
    this._ssb.ebt.block(this._ssb.id, feedId, false)

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

  _block(feedId) {
    if (this._blocked.has(feedId)) return
    debug('will block replication of %s', feedId)

    const hops = this._getCurrentHops(feedId)
    this._requestableMains.delete(feedId)
    this._requested.delete(feedId)
    this._requestedTreeFromMain.delete(feedId)
    this._blocked.set(feedId, hops)
    this._ssb.ebt.request(feedId, false)
    this._ssb.ebt.block(this._ssb.id, feedId, true)

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

    this._requestableMains.delete(feedId)
    this._requested.delete(feedId)
    this._requestedTreeFromMain.delete(feedId)
    this._blocked.delete(feedId)
    this._tombstoned.add(feedId)
    this._ssb.ebt.request(feedId, false)

    // Weave through all of the subfeeds and tombstone them too
    if (shouldWeave) {
      const opts = { root: feedId, tombstoned: null, old: true, live: false }
      pull(
        this._ssb.metafeeds.branchStream(opts),
        pull.drain((branch) => {
          const leaf = branch[branch.length - 1]
          this._tombstone(leaf.id, false)
        })
      )
    }
  }

  _supportsMetafeedTree(mainFeedId, cb) {
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
      if (
        this._requestableMains.size === 0 &&
        this._requestableRoots.size === 0
      ) {
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

    const mainFlushables = pull(
      pull.asyncMap(([mainFeedId, hops], cb) => {
        const template = this._findTemplateForCategory(hops)
        if (!template) return cb(null, [mainFeedId, false])

        this._supportsMetafeedTree(mainFeedId, (err, supports) => {
          if (err) cb(err)
          else cb(null, [mainFeedId, supports])
        })
      }),
      pull.map(([mainFeedId, supportsMetafeedTree]) => {
        if (supportsMetafeedTree) {
          this._requestTreeFromMain(mainFeedId)
        } else {
          this._request(mainFeedId)
        }
        return null
      })
    )

    const rootFlushables =
      this._templates && this._templates.has('group')
        ? pull(
            pull.values([...this._requestableRoots.entries()]),
            pull.map(([rootFeedId]) => {
              this._requestTreeFromRoot(rootFeedId)
              return null
            })
          )
        : pull.empty()

    pull(
      cat([mainFlushables, rootFlushables]),
      pull.onEnd((err) => {
        this._flushing = false
        if (err) console.error(err)
        if (this._templates) this._setupStreamDrainers()
        if (this._wantsMoreFlushing) {
          this._scheduleDebouncedFlush()
        }
      })
    )
  }
}

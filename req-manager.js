const pull = require('pull-stream')
const {
  where,
  and,
  authorIsBendyButtV1,
  isPublic,
  live,
  toPullStream,
} = require('ssb-db2/operators')
const bendyButtEBTFormat = require('ssb-ebt/formats/bendy-butt')
const indexedEBTFormat = require('ssb-ebt/formats/indexed')
const Template = require('./template')

const DEFAULT_PERIOD = 150

module.exports = class RequestManager {
  constructor(ssb, opts, metafeedFinder) {
    this._ssb = ssb
    this._opts = opts
    this._metafeedFinder = metafeedFinder
    this._period =
      typeof opts.debouncePeriod === 'number'
        ? opts.debouncePeriod
        : DEFAULT_PERIOD
    this._requestables = new Map()
    this._requestedDirectly = new Map()
    this._requestedIndirectly = new Map()
    this._tombstoned = new Set()
    this._flushing = false
    this._wantsMoreFlushing = false
    this._latestAdd = 0
    this._timer = null
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
    if (this._requestables.has(feedId)) return
    if (this._requestedDirectly.has(feedId)) return
    if (this._requestedIndirectly.has(feedId)) return

    this._requestables.set(feedId, hops)
    this._latestAdd = Date.now()
    this._scheduleDebouncedFlush()
  }

  reconfigure(opts) {
    this._opts = { ...this._opts, opts }
  }

  _setupTemplates(optsPartialReplication) {
    if (!optsPartialReplication) return null
    if (Object.values(optsPartialReplication).every((t) => !t)) return null
    const hopsArr = Object.keys(optsPartialReplication).map(Number)
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
      if (that._liveDrainer) that._liveDrainer.abort()
      fn.apply(this, args)
    })
  }

  _scanBendyButtFeeds() {
    if (this._liveDrainer) this._liveDrainer.abort()
    if (!this._hasCloseHook) this._setupCloseHook()

    pull(
      this._ssb.db.query(
        where(and(authorIsBendyButtV1(), isPublic())),
        live({ old: true }),
        toPullStream()
      ),
      pull.filter((msg) => this._ssb.metafeeds.validate.isValid(msg)),
      (this._liveDrainer = pull.drain(
        (msg) => {
          const { type, subfeed } = msg.value.content
          if (this._tombstoned.has(subfeed)) return

          if (type.startsWith('metafeed/add/')) {
            setTimeout(() => {
              if (this._tombstoned.has(subfeed)) return
              const path = this._getMetafeedTreePath(msg)
              const metaFeedId = path[0]
              const mainFeedId = this._metafeedFinder.getInverse(metaFeedId)
              if (!this._requestedIndirectly.has(mainFeedId)) return
              const hops = this._requestedIndirectly.get(mainFeedId)
              const template = this._findTemplateForHops(hops)
              if (!template) return
              const matchedNode = template.matchPath(path, mainFeedId)
              if (!matchedNode) return
              this._requestDirectly(subfeed, matchedNode['$format'])
            }, this._period)
          } else if (type === 'metafeed/tombstone') {
            this._tombstoned.add(subfeed)
            this._ssb.ebt.request(subfeed, false)
          }
        },
        (err) => {
          if (err) return cb(err)
        }
      ))
    )
  }

  /**
   * Returns an array that represents the path from root meta feed to the given
   * leaf `msg`.
   *
   * @param {*} msg a metafeed message
   * @returns {Array}
   */
  _getMetafeedTreePath(msg) {
    const details = this._ssb.metafeeds.findByIdSync(msg.value.content.subfeed)
    const path = [details]
    while (true) {
      const head = path[0]
      const details = this._ssb.metafeeds.findByIdSync(head.metafeed)
      if (details) {
        path.unshift(details)
      } else {
        path.unshift(head.metafeed)
        return path
      }
    }
  }

  /**
   * @param {string} feedId classic feed ref or bendybutt feed URI
   */
  _requestDirectly(feedId, ebtFormat = undefined) {
    const hops = this._requestables.get(feedId)
    this._requestedDirectly.set(feedId, hops)
    this._requestables.delete(feedId)
    this._ssb.ebt.request(feedId, true, ebtFormat)
  }

  /**
   * @param {string} mainFeedId classic feed ref which has announced a root MF
   * @param {object} template one of the nodes in opts.partialReplication
   */
  _requestIndirectly(mainFeedId, template) {
    const hops = this._requestables.get(mainFeedId)
    this._requestedIndirectly.set(mainFeedId, hops)
    this._requestables.delete(mainFeedId)

    // Get metafeedId for this feedId
    this._metafeedFinder.get(mainFeedId, (err, metafeedId) => {
      if (err) {
        console.error(err)
      } else if (!metafeedId) {
        console.error('cannot partially replicate ' + mainFeedId)
      } else {
        this._requestDirectly(metafeedId)
      }
    })
  }

  _supportsPartialReplication(feedId, cb) {
    this._metafeedFinder.get(feedId, (err, metafeedId) => {
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
            this._requestIndirectly(feedId)
          } else {
            this._requestDirectly(feedId)
          }
        },
        (err) => {
          if (err) console.error(err)
          if (this._templates) this._scanBendyButtFeeds()
          this._flushing = false
          if (this._wantsMoreFlushing) {
            this._scheduleDebouncedFlush()
          }
        }
      )
    )
  }
}

const pull = require('pull-stream')
const Ref = require('ssb-ref')
const { QL0 } = require('ssb-subset-ql')
const { isBendyButtV1FeedSSBURI } = require('ssb-uri2')
const {
  where,
  and,
  author,
  isPublic,
  live,
  toPullStream,
} = require('ssb-db2/operators')
const bendyButtEBTFormat = require('ssb-ebt/formats/bendy-butt')
const indexedEBTFormat = require('ssb-ebt/formats/indexed')

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
    this._flushing = false
    this._wantsMoreFlushing = false
    this._latestAdd = 0
    this._timer = null
    this._hopsLevels = !this._opts.partialReplication
      ? []
      : Object.keys(this._opts.partialReplication).map(Number).sort()

    // If at least one hops template is configured, then setup ssb-ebt
    if (
      this._opts.partialReplication &&
      Object.values(this._opts.partialReplication).some((templ) => !!templ)
    ) {
      this._ssb.ebt.registerFormat(indexedEBTFormat)
      this._ssb.ebt.registerFormat(bendyButtEBTFormat)
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
        this._traverse(metafeedId, template, mainFeedId)
      }
    })
  }

  /**
   * @param {string | object} input a metafeedId or a msg concerning a metafeed
   * @param {object} template one of the nodes in opts.partialReplication
   * @param {string} mainFeedId
   */
  _traverse(input, template, mainFeedId) {
    if (!this._matchesTemplate(input, template)) return

    const metafeedId =
      typeof input === 'string' ? input : input.value.content.subfeed

    this._requestDirectly(metafeedId)

    pull(
      this._ssb.db.query(
        where(and(author(metafeedId), isPublic())),
        live({ old: true }),
        toPullStream()
      ),
      pull.drain((msg) => {
        const { type, subfeed } = msg.value.content
        if (type.startsWith('metafeed/add/')) {
          for (const childTemplate of template.subfeeds) {
            if (this._matchesTemplate(msg, childTemplate, mainFeedId)) {
              if (isBendyButtV1FeedSSBURI(subfeed)) {
                this._traverse(msg, childTemplate, mainFeedId)
              } else if (Ref.isFeedId(subfeed)) {
                this._requestDirectly(subfeed, childTemplate['$format'])
              } else {
                console.error('cannot replicate unknown feed type: ' + subfeed)
              }
              break
            }
          }
        } else if (type === 'metafeed/tombstone') {
          this._ssb.ebt.request(subfeed, false)
        }
      })
    )
  }

  _matchesTemplate(input, template, mainFeedId) {
    // Input is `metafeedId`
    if (typeof input === 'string' && isBendyButtV1FeedSSBURI(input)) {
      const keys = Object.keys(template)
      return (
        keys.length === 1 &&
        keys[0] === 'subfeeds' &&
        Array.isArray(template.subfeeds)
      )
    }

    // Input is a bendybutt message
    if (typeof input === 'object' && input.value && input.value.content) {
      const msg = input
      const content = msg.value.content

      // If present, feedpurpose must match
      if (
        template.feedpurpose &&
        content.feedpurpose !== template.feedpurpose
      ) {
        return false
      }

      // If present, metadata must match
      if (template.metadata && content.metadata) {
        // If querylang is present, match ssb-ql-0 queries
        if (template.metadata.querylang !== content.metadata.querylang) {
          return false
        }
        if (template.metadata.querylang === 'ssb-ql-0') {
          if (!QL0.parse(content.metadata.query)) return false
          if (template.metadata.query) {
            if (template.metadata.query.author === '$main') {
              template.metadata.query.author = mainFeedId
            }
            if (
              !QL0.isEquals(content.metadata.query, template.metadata.query)
            ) {
              return false
            }
          }
        }

        // Any other metadata field must match exactly
        for (const field of Object.keys(template.metadata)) {
          // Ignore these because we already handled them:
          if (field === 'query') continue
          if (field === 'querylang') continue

          if (content.metadata[field] !== template.metadata[field]) return false
        }
      }

      return true
    }

    return false
  }

  _supportsPartialReplication(feedId, cb) {
    this._metafeedFinder.get(feedId, (err, metafeedId) => {
      if (err) cb(err)
      else cb(null, !!metafeedId)
    })
  }

  _findTemplateForHops(hops) {
    if (!this._opts.partialReplication) return null
    const eligible = this._hopsLevels.filter((h) => h >= hops)
    const picked = Math.min(...eligible)
    const x = this._opts.partialReplication[picked]
    return x
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
        if (!template) return cb(null, [feedId, null])

        this._supportsPartialReplication(feedId, (err, supports) => {
          if (err) {
            cb(err)
          } else if (supports) {
            cb(null, [feedId, template])
          } else {
            cb(null, [feedId, null])
          }
        })
      }),
      pull.drain(
        ([feedId, template]) => {
          if (template) {
            this._requestIndirectly(feedId, template)
          } else {
            this._requestDirectly(feedId)
          }
        },
        (err) => {
          if (err) console.error(err)
          this._flushing = false
          if (this._wantsMoreFlushing) {
            this._scheduleDebouncedFlush()
          }
        }
      )
    )
  }
}

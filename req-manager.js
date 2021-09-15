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
    this._requestables = new Set()
    this._requestedFully = new Set()
    this._requestedPartially = new Set()
    this._flushing = false
    this._wantsMoreFlushing = false
    this._latestAdd = 0
    this._timer = null
  }

  add(feedId) {
    if (this._requestables.has(feedId)) return
    if (this._requestedFully.has(feedId)) return
    if (this._requestedPartially.has(feedId)) return

    this._requestables.add(feedId)
    this._latestAdd = Date.now()
    this._scheduleDebouncedFlush()
  }

  reconfigure(opts) {
    this._opts = { ...this._opts, opts }
    // FIXME: trigger a recalculation somehow
  }

  /**
   * @param {string} feedId classic feed ref or bendybutt feed URI
   */
  _requestFully(feedId) {
    this._requestables.delete(feedId)
    this._requestedFully.add(feedId)
    this._ssb.ebt.request(feedId, true)
  }

  /**
   * @param {string} mainFeedId classic feed ref which has announced a root MF
   */
  _requestPartially(mainFeedId) {
    this._requestables.delete(mainFeedId)
    this._requestedPartially.add(mainFeedId)

    // Get metafeedId for this feedId
    this._metafeedFinder.get(mainFeedId, (err, metafeedId) => {
      if (err) {
        console.error(err)
      } else if (!metafeedId) {
        console.error('cannot partially replicate ' + mainFeedId)
      } else {
        this._traverse(metafeedId, this._opts.partialReplication, mainFeedId)
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

    this._requestFully(metafeedId)

    // ssb-db2 live query for metafeedId
    //  * for every *tombstoned* subfeed, call ssb.ebt.request(subfeedId, false)
    //  * for every *added* subfeed, match against template.subfeeds
    //    * if not matched, ignore
    //    * if matched and is classic feed, _requestFully(subfeedId)
    //    * if matched with subfeeds and is bendybutt feed, then
    //      * traverse(mainfeedId, subfeedId, matchedTemplate)
    pull(
      this._ssb.db.query(
        where(and(author(metafeedId), isPublic())),
        live({ old: true }),
        toPullStream()
      ),
      // FIXME: this drain multiplied by N peers with support for
      // partialReplication multiplied by M sub-meta-feeds for each means N*M
      // live drains. Sounds like a performance nightmare, if N > 1000.
      //
      // Should we do instead one drain for all bendybutt messages and based
      // on the bbmsg look up who it belongs to and then traverse the template?
      pull.drain((msg) => {
        const { type, subfeed } = msg.value.content
        if (type.startsWith('metafeed/add/')) {
          for (const childTemplate of template.subfeeds) {
            if (this._matchesTemplate(msg, childTemplate, mainFeedId)) {
              if (isBendyButtV1FeedSSBURI(subfeed)) {
                this._traverse(msg, childTemplate, mainFeedId)
              } else if (Ref.isFeedId(subfeed)) {
                this._requestFully(subfeed)
              } else {
                console.error('cannot replicate unknown feed type: ' + subfeed)
              }
              break
            }
          }
        } else if (type === 'metafeed/tombstone') {
          // FIXME: what if this happens very quickly after add?
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
      pull.values([...this._requestables]),
      pull.asyncMap((feedId, cb) => {
        if (!this._opts.partialReplication) return cb(null, [feedId, false])
        if (feedId === this._ssb.id) return cb(null, [feedId, true])

        this._supportsPartialReplication(feedId, (err, partially) => {
          if (err) cb(err)
          else cb(null, [feedId, partially])
        })
      }),
      pull.drain(
        ([feedId, partially]) => {
          if (partially) {
            this._requestPartially(feedId)
          } else {
            this._requestFully(feedId)
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

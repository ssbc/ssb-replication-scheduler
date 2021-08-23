const pull = require('pull-stream')

const DEFAULT_PERIOD = 500

module.exports = class RequestManager {
  constructor(ssb, opts, metafeedFinder, period) {
    this._ssb = ssb
    this._opts = opts
    this._metafeedFinder = metafeedFinder
    this._period = period || DEFAULT_PERIOD
    this._requestables = new Set()
    this._requestedFully = new Set()
    this._requestedPartially = new Set()
    this._flushing = false
    this._wantsMoreFlushing = false
    this._latestAdd = 0
    this._timer = null
  }

  add(feedId) {
    if (this._requestedFully.has(feedId)) return
    if (this._requestedPartially.has(feedId)) return

    this._requestables.add(feedId)
    this._latestAdd = Date.now()
    this._scheduleDebouncedFlush()
  }

  reconfigure(opts) {
    this._opts = { ...this._opts, opts }
  }

  _requestFully(feedId) {
    this._requestables.delete(feedId)
    this._requestedFully.add(feedId)
    this._ssb.ebt.request(feedId, true)
  }

  _requestPartially(feedId) {
    this._requestables.delete(feedId)
    this._requestedPartially.add(feedId)
    // FIXME: go through this._opts.partialReplication to detect subfeeds
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

    if (this._timer) return // Timer is already enabled
    this._timer = setInterval(() => {
      // Turn off the timer if there is nothing to flush
      if (this._requestables.size === 0) {
        clearInterval(this._timer)
        this._timer = null
      }
      // Flush if enough time has passed
      else if (Date.now() - this._latestAdd > this._period) this._flush()
    }, this._period * 0.5)
  }

  _flush() {
    pull(
      pull.values([...this._requestables]),
      pull.asyncMap((feedId, cb) => {
        if (!this._opts.partialReplication) return cb(null, [feedId, false])

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

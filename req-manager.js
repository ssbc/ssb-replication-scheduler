const pull = require('pull-stream')

module.exports = class RequestManager {
  constructor(ssb, opts, metafeedFinder) {
    this._ssb = ssb
    this._opts = opts
    this._metafeedFinder = metafeedFinder
    this._requestables = new Set()
    this._requestedFully = new Set()
    this._requestedPartially = new Set()
    this._flushing = false
    this._wantsMoreFlushing = false
  }

  add(feedId) {
    if (this._requestedFully.has(feedId)) return
    if (this._requestedPartially.has(feedId)) return

    this._requestables.add(feedId)
    this._flush() // FIXME: this may need some debouncing
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

  _flush() {
    if (this._flushing) {
      this._wantsMoreFlushing = true
      return
    }
    this._wantsMoreFlushing = false

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
            setTimeout(() => {
              this._flush()
            })
          }
        }
      )
    )
  }
}

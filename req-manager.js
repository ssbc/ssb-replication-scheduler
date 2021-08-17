const pull = require('pull-stream')

const DEFAULT_OPTS = {
  partially: false,
}

module.exports = class RequestManager {
  constructor(ssb, config) {
    this._ssb = ssb
    this._opts = config.replicationScheduler || DEFAULT_OPTS
    this._requestables = new Set()
    this._requestedFully = new Set()
    this._requestedPartially = new Set()
    this._flushing = false
    this._wantsMoreFlushing = false
  }

  add(feedId) {
    this._requestables.add(feedId)
    this._flush()
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
    // FIXME: implement. Go through this._opts.partially to detect subfeeds
  }

  _supportsPartialReplication(feedId, cb) {
    // FIXME: implement
    cb(null, false)
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
        if (!this._opts.partially) return cb(null, false)

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

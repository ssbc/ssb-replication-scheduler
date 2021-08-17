const pull = require('pull-stream')

module.exports = class RequestManager {
  constructor(ssb) {
    this._ssb = ssb
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

  _requestFully(feedId) {
    this._requestables.delete(feedId)
    this._requestedFully.add(feedId)
    this._ssb.ebt.request(feedId, true)
  }

  _requestPartially(feedId) {
    this._requestables.delete(feedId)
    this._requestedPartially.add(feedId)
    // FIXME: implement
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
        if (feedId === this._ssb.id) return cb(null, [feedId, false])

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

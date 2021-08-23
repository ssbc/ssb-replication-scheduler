const pull = require('pull-stream')
const Ref = require('ssb-ref')
const debug = require('debug')('ssb:replication-scheduler')
const SSBURI = require('ssb-uri2')
const detectSsbNetworkErrorSeverity = require('ssb-network-errors')
const { where, type, toPullStream } = require('ssb-db2/operators')

const DEFAULT_PERIOD = 500

module.exports = class MetafeedFinder {
  constructor(ssb, opts, period) {
    this._ssb = ssb
    this._opts = opts
    this._period = period || DEFAULT_PERIOD
    this._map = new Map()
    this._requestsByMainfeedId = new Map()
    this._latestRequestTime = 0
    this._timer = null

    if (this._opts.partialReplication) {
      this._loadAllFromLog()
    }
  }

  get(mainFeedId, cb) {
    if (this._map.has(mainFeedId)) {
      const metaFeedId = this._map.get(mainFeedId)
      cb(null, metaFeedId)
      return
    } else {
      this._request(mainFeedId, cb)
    }
  }

  _loadAllFromLog() {
    if (!ssb.db || !ssb.db.query) {
      throw new Error(
        'ssb-replication-scheduler expects ssb-db2 to be installed, to use partial replication'
      )
    }

    pull(
      this._ssb.db.query(where(type('metafeed/announce')), toPullStream()),
      pull.drain((msg) => {
        const [mainFeedId, metaFeedId] = this._pluckFromAnnounceMsg(msg)
        if (!mainFeedId || !metaFeedId) return
        this._map.set(mainFeedId, metaFeedId)
      })
    )
  }

  _pluckFromAnnounceMsg(msg) {
    const { author, content } = msg.value
    if (!Ref.isFeedId(author)) return []
    const mainFeedId = author
    if (!SSBURI.isBendyButtV1FeedSSBURI(content.metafeed)) return []
    const metaFeedId = content.metafeed
    return [mainFeedId, metaFeedId]
  }

  _request(mainFeedId, cb) {
    const callbacks = this._requestsByMainfeedId.get(mainFeedId) || []
    callbacks.push(cb)
    this._requestsByMainfeedId.set(mainFeedId, callbacks)
    this._latestRequestTime = Date.now()
    this._scheduleDebouncedFlush()
  }

  _persist(msg) {
    this._ssb.db.addOOO(msg.value, (err) => {
      if (err) {
        debug(
          'failed to addOOO for a metafeed/announce: %s',
          err.message || err
        )
      }
    })
  }

  async _forEachNeighborPeer(run) {
    for (const peerId of Object.keys(this._ssb.peers)) {
      for (const rpc of this._ssb.peers[peerId]) {
        const goToNext = await new Promise((resolve) => run(rpc, resolve))
        if (!goToNext) return
      }
    }
  }

  _scheduleDebouncedFlush() {
    if (this._timer) return // Timer is already enabled
    this._timer = setInterval(() => {
      // Turn off the timer if there is nothing to flush
      if (this._requestsByMainfeedId.size === 0) {
        clearInterval(this._timer)
        this._timer = null
      }
      // Flush if enough time has passed
      else if (Date.now() - this._latestRequestTime > this._period)
        this._flush()
    }, this._period * 0.5)
  }

  _makeQL1(map) {
    const query = {
      op: 'or',
      args: [],
    }
    for (const mainFeedId of map.keys()) {
      query.args.push({
        op: 'and',
        args: [
          { op: 'type', string: 'metafeed/announce' },
          { op: 'author', feed: mainFeedId },
        ],
      })
    }
    return query
  }

  async _flush() {
    let drainer
    const requests = new Map(this._requestsByMainfeedId)
    this._requestsByMainfeedId.clear()

    await this._forEachNeighborPeer((rpc, goToNextNeighbor) => {
      pull(
        rpc.getSubset(this._makeQL1(requests), { querylang: 'ssb-ql-1' }),
        (drainer = pull.drain(
          (msg) => {
            const [mainFeedId, metaFeedId] = this._pluckFromAnnounceMsg(msg)
            if (!mainFeedId || !metaFeedId) return
            if (requests.has(mainFeedId)) {
              this._map.set(mainFeedId, metaFeedId)
              this._persist(msg)
              const callbacks = requests.get(mainFeedId)
              requests.delete(mainFeedId)
              for (const cb of callbacks) cb(null, metaFeedId)
              if (requests.size === 0) {
                drainer.abort()
                goToNextNeighbor(false)
              } else {
                goToNextNeighbor(true)
              }
            }
          },
          (err) => {
            if (err && detectSsbNetworkErrorSeverity(err) >= 2) {
              debug(
                'failed "getSubset" muxrpc at peer %s because: %s',
                rpc.id,
                err.message || err
              )
            }
            goToNextNeighbor(true)
          }
        ))
      )
    })

    if (requests.size > 0) {
      // We couldn't find metaFeedIds for some mainFeedIds, so we assume there
      // none. Note, this may give false negatives depending on who you're
      // connected to!
      for (const callbacks of requests.values()) {
        for (const cb of callbacks) cb(null, null)
      }
      requests.clear()
    }
  }
}

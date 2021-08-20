// SPDX-FileCopyrightText: 2021 Andre 'Staltz' Medeiros
//
// SPDX-License-Identifier: LGPL-3.0-only

const pull = require('pull-stream')
const RequestManager = require('./req-manager')

const DEFAULT_OPTS = {
  partialReplication: false,
}

exports.name = 'replicationScheduler'
exports.version = '1.0.0'
exports.manifest = {
  reconfigure: 'sync',
}

exports.init = function (ssb, config) {
  if (!ssb.ebt) {
    throw new Error('ssb-replication-scheduler expects ssb-ebt to be installed')
  }
  if (!ssb.friends) {
    throw new Error(
      'ssb-replication-scheduler expects ssb-friends to be installed'
    )
  }

  const opts = config.replicationScheduler || DEFAULT_OPTS

  const requestManager = new RequestManager(ssb, opts)

  // Note: ssb.ebt.request and ssb.ebt.block are idempotent operations,
  // so it's safe to call these methods redundantly, which is most likely
  // true in most cases. These three blocks below may sometimes overlap, but
  // that's okay, as long as we cover *all* cases.

  // Replicate myself ASAP, without request manager
  ssb.ebt.request(ssb.id, true)

  // For each edge in the social graph, call either `request` or `block`
  pull(
    ssb.friends.graphStream({ old: true, live: true }),
    pull.drain((graph) => {
      for (const source of Object.keys(graph)) {
        for (const dest of Object.keys(graph[source])) {
          const value = graph[source][dest]
          // Only if I am the `source` and `value >= 0`, request replication
          if (source === ssb.id) {
            if (value >= 0) requestManager.add(dest)
            else ssb.ebt.request(dest, false)
          }
          // Compute every block edge, unless I am the edge destination
          if (dest !== ssb.id) {
            ssb.ebt.block(source, dest, value === -1)
          }
        }
      }
    })
  )

  // request/block nodes at a reachable distance (within hops config) from me
  pull(
    ssb.friends.hopStream({ old: true, live: true }),
    pull.drain((hops) => {
      for (const dest of Object.keys(hops)) {
        const value = hops[dest]
        // myself or friendly peers
        if (value >= 0) {
          requestManager.add(dest)
          ssb.ebt.block(ssb.id, dest, false)
        }
        // blocked peers
        else if (value === -1) {
          ssb.ebt.request(dest, false)
          ssb.ebt.block(ssb.id, dest, true)
        }
        // unfollowed/unblocked peers
        else if (value < -1) {
          ssb.ebt.request(dest, false)
        }
      }
    })
  )

  return {
    reconfigure(opts) {
      requestManager.reconfigure(opts)
    },
  }
}

// SPDX-FileCopyrightText: 2021 Andre 'Staltz' Medeiros
//
// SPDX-License-Identifier: LGPL-3.0-only

const pull = require('pull-stream')
const RequestManager = require('./req-manager')

const DEFAULT_OPTS = {
  partialReplication: null,
  autostart: true,
}

exports.name = 'replicationScheduler'
exports.version = '2.0.0'
exports.manifest = {
  start: 'sync',
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
  let started = false
  let drainGraphStream = null
  let drainHopStream = null

  if (opts.autostart === true || typeof opts.autostart === 'undefined') {
    start()
  }

  function monitorGraphStream() {
    // Take every block or unblock into account, except if it's about me
    pull(
      ssb.friends.graphStream({ old: true, live: true }),
      (drainGraphStream = pull.drain((graph) => {
        for (const source of Object.keys(graph)) {
          for (const dest of Object.keys(graph[source])) {
            if (source !== ssb.id && dest !== ssb.id) {
              const value = graph[source][dest]
              ssb.ebt.block(source, dest, value === -1)
            }
          }
        }
      }))
    )
  }

  function monitorHopStream() {
    // request/block nodes at a reachable distance (within hops config) from me
    pull(
      ssb.friends.hopStream({ old: true, live: true }),
      (drainHopStream = pull.drain((hops) => {
        for (const dest of Object.keys(hops)) {
          requestManager.add(dest, hops[dest])
        }
      }))
    )
  }

  function monitorGroupMembersStream() {
    //TODO add live arguments to tribes2

    if (!ssb.tribes2) return

    setInterval(() => {
      pull(
        ssb.tribes2.list(),
        pull.map((group) => ssb.tribes2.listMembers(group.id)),
        pull.flatten(),
        pull.unique(),
        pull.collect((err, groupMembers) => {
          console.log('groupMembers', groupMembers)
        })
      )
    }, 500)
  }

  function start() {
    if (started) return
    started = true

    // Replicate myself ASAP, without request manager
    ssb.ebt.request(ssb.id, true)

    if (ssb.db) {
      ssb.db.getIndexingActive()((active) => {
        if (active > 0) {
          drainGraphStream.abort()
          drainGraphStream = null
          drainHopStream.abort()
          drainHopStream = null
        } else {
          monitorGraphStream()
          monitorHopStream()
          monitorGroupMembersStream()
        }
      }, true)
    } else {
      monitorGraphStream()
      monitorHopStream()
      monitorGroupMembersStream()
    }
  }

  function reconfigure(opts) {
    requestManager.reconfigure(opts)
  }

  return {
    start,
    reconfigure,
  }
}

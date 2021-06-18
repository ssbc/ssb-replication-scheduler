const pull = require('pull-stream')

exports.name = 'replicationScheduler'
exports.version = '1.0.0'
exports.manifest = {}

exports.init = function (ssb, config) {
  if (!ssb.ebt) {
    throw new Error('ssb-replication-scheduler expects ssb-ebt to be installed')
  }
  if (!ssb.friends) {
    throw new Error('ssb-replication-scheduler expects ssb-friends to be installed')
  }

  // Replicate myself
  ssb.ebt.request(ssb.id, true)

  // For each edge in the social graph, call either `request` or `block`
  pull(
    ssb.friends.graphStream({live: true, old: true}),
    pull.map((data) => {
      // console.log(ssb.id, data)
      // Individual edge updates
      if (data.source && data.dest) {
        return pull.values([data])
      }
      // Initial data containing all edges
      else {
        const arr = []
        for (const source of Object.keys(data)) {
          for (const dest of Object.keys(data[source])) {
            arr.push({source, dest, value: data[source][dest]})
          }
        }
        return pull.values(arr)
      }
    }),
    pull.flatten(),
    pull.drain(({source, dest, value}) => {
      if (source === ssb.id) ssb.ebt.request(dest, value !== -1)
      if (dest !== ssb.id) ssb.ebt.block(source, dest, value === -1)
    }),
  )

  return {}
}

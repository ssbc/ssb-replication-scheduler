const pull = require('pull-stream')

exports.name = 'replicationScheduler'
exports.version = '1.0.0'
exports.manifest = {}

exports.init = function (ssb, config) {
  if (!ssb.ebt) {
    throw new Error('ssb-replication-scheduler expects ssb-ebt to be installed')
  }

  // Replicate myself
  ssb.ebt.request(ssb.id, true)

  // For each edge in the social graph, call either `request` or `block`
  pull(
    ssb.friends.stream(),
    pull.filter((contacts) => !!contacts),
    pull.map((contacts) => {
      // Individual edge updates
      if (contacts.from && contacts.to) {
        return pull.values([contacts])
      }
      // Initial data containing all edges
      else {
        const arr = []
        for (const from of Object.keys(contacts)) {
          for (const to of Object.keys(contacts[from])) {
            arr.push({from, to, value: contacts[from][to]})
          }
        }
        return pull.values(arr)
      }
    }),
    pull.flatten(),
    pull.drain(({from, to, value}) => {
      if (from === ssb.id) ssb.ebt.request(to, value !== false)
      if (to !== ssb.id) ssb.ebt.block(from, to, value === false)
    }),
  )

  return {}
}

exports.name = 'replicationScheduler'
exports.version = '1.0.0'
exports.manifest = {}

exports.init = function (sbot, config) {
  if (!sbot.ebt) {
    throw new Error('ssb-replication-scheduler expects ssb-ebt to be installed')
  }

  // Replicate myself
  ssb.ebt.request(sbot.id, true)

  // For each edge in the social graph, call either `request` or `block`
  pull(
    sbot.friends.stream(),
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
      if (from === sbot.id) ssb.ebt.request(to, value !== false)
      if (to !== sbot.id) ssb.ebt.block(from, to, value === false)
    }),
  )

  return {}
}

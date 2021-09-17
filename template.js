const { isBendyButtV1FeedSSBURI } = require('ssb-uri2')
const { QL0 } = require('ssb-subset-ql')

/**
 * Algorithms for the "replication template" object from the SSB config.
 */
module.exports = class Template {
  constructor(node) {
    this._rootNode = node
  }

  hasIndexLeaf() {
    const indexes = this._find(
      this._rootNode,
      (node) => node.feedpurpose === 'indexes'
    )
    if (!indexes) return false
    const leaf = this._find(indexes, (node) => node['$format'] === 'indexed')
    return !!leaf
  }

  _find(node, fn) {
    if (!node) return null
    if (fn(node)) return node

    if (node.subfeeds && Array.isArray(node.subfeeds)) {
      for (const childNode of node.subfeeds) {
        if (this._find(childNode, fn)) {
          return childNode
        }
      }
    }
  }

  matchPath(path, mainFeedId) {
    return this._matchPath(path, this._rootNode, mainFeedId)
  }

  _matchPath(path, node, mainFeedId) {
    if (path.length === 0) return null
    const head = path[0]

    // Head is `metafeedId`
    if (typeof head === 'string' && isBendyButtV1FeedSSBURI(head)) {
      const keys = Object.keys(node)
      const rootMatches =
        keys.length === 1 &&
        keys[0] === 'subfeeds' &&
        Array.isArray(node.subfeeds)

      if (!rootMatches) {
        return null
      } else {
        const childPath = path.slice(1)
        for (const childNode of node.subfeeds) {
          const matched = this._matchPath(childPath, childNode, mainFeedId)
          if (matched) return matched
        }
        return null
      }
    }

    // Head is a subfeed details
    if (typeof head === 'object') {
      // If present, feedpurpose must match
      if (node.feedpurpose && head.feedpurpose !== node.feedpurpose) {
        return null
      }

      // If present, metadata must match
      if (node.metadata && head.metadata) {
        // If querylang is present, match ssb-ql-0 queries
        if (node.metadata.querylang !== head.metadata.querylang) {
          return null
        }
        if (node.metadata.querylang === 'ssb-ql-0') {
          if (!QL0.parse(head.metadata.query)) return null
          if (node.metadata.query) {
            const nodeQuery = { ...node.metadata.query }
            if (nodeQuery.author === '$main') nodeQuery.author = mainFeedId
            if (!QL0.isEquals(head.metadata.query, nodeQuery)) {
              return null
            }
          }
        }

        // Any other metadata field must match exactly
        for (const field of Object.keys(node.metadata)) {
          // Ignore these because we already handled them:
          if (field === 'query') continue
          if (field === 'querylang') continue

          if (head.metadata[field] !== node.metadata[field]) {
            return null
          }
        }
      }

      if (Array.isArray(node.subfeeds)) {
        const childPath = path.slice(1)
        for (const childNode of node.subfeeds) {
          const matched = this._matchPath(childPath, childNode, mainFeedId)
          if (matched) return matched
        }
        return node
      } else {
        return node
      }
    }

    return null
  }
}

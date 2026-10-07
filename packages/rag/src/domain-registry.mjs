/* Domain registry: defines logical domains, their index identifiers, default retrieval params, and metadata schema. */
export const domainRegistry = {
  notes: {
    name: 'notes',
    index: 'notes_index',
    defaults: { k: 6, threshold: 0.0, weight: 1.0 },
    metadataSchema: {
      id: 'string',
      title: 'string',
      author: 'string',
      createdAt: 'string',
      tags: 'array',
      content: 'string'
    }
  },
  code: {
    name: 'code',
    index: 'code_index',
    defaults: { k: 8, threshold: 0.0, weight: 1.2 },
    metadataSchema: {
      id: 'string',
      path: 'string',
      repo: 'string',
      language: 'string',
      snippet: 'string'
    }
  },
  docs: {
    name: 'docs',
    index: 'docs_index',
    defaults: { k: 6, threshold: 0.0, weight: 0.9 },
    metadataSchema: {
      id: 'string',
      title: 'string',
      section: 'string',
      url: 'string',
      content: 'string'
    }
  }
};

export function getDomain(name) {
  return domainRegistry[name] || null;
}

export function listDomains() {
  return Object.keys(domainRegistry);
}

export default { domainRegistry, getDomain, listDomains };
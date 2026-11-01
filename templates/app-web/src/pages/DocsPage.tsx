import React, { useEffect, useState } from 'react';
import { loadDocs, type DocItem } from '../utils/contentLoader';

export default function DocsPage() {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchDocs() {
      try {
        const docsData = await loadDocs();
        setDocs(docsData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load documentation');
      } finally {
        setLoading(false);
      }
    }
    
    fetchDocs();
  }, []);

  if (loading) {
    return (
      <div className="px-4 py-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-2 text-gray-600">Loading documentation...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-8">
        <div className="text-center">
          <p className="text-red-600">Error loading documentation: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Documentation</h1>
        <p className="mt-2 text-gray-600">
          Comprehensive guides and references for __TITLE__.
        </p>
      </div>

      {docs.length === 0 ? (
        <div className="text-center py-12">
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            No documentation available yet
          </h2>
          <p className="text-gray-600 mb-4">
            Documentation will appear here as it becomes available.
          </p>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 max-w-md mx-auto">
            <p className="text-sm text-blue-800">
              💡 <strong>Pro tip:</strong> Create documentation files in your{' '}
              <code className="bg-blue-100 px-1 rounded">src/data/</code> directory 
              and add them to <code className="bg-blue-100 px-1 rounded">docs-index.json</code> 
              to get started.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {docs.map((doc) => (
            <div
              key={doc.slug}
              className="border border-gray-200 rounded-lg p-6 hover:shadow-md transition-shadow"
            >
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                {doc.title}
              </h3>
              {doc.summary && (
                <p className="text-gray-600 text-sm mb-4">{doc.summary}</p>
              )}
              {doc.tags && doc.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-4">
                  {doc.tags.map((tag, index) => (
                    <span
                      key={index}
                      className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <div className="text-sm text-blue-600 font-medium">
                Read more →
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
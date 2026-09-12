import React, { useEffect, useState } from 'react';
import { loadGuides, type GuideItem } from '../utils/contentLoader';

export default function GuidesPage() {
  const [guides, setGuides] = useState<GuideItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchGuides() {
      try {
        const guidesData = await loadGuides();
        setGuides(guidesData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load guides');
      } finally {
        setLoading(false);
      }
    }
    
    fetchGuides();
  }, []);

  if (loading) {
    return (
      <div className="px-4 py-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-2 text-gray-600">Loading guides...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-8">
        <div className="text-center">
          <p className="text-red-600">Error loading guides: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Guides</h1>
        <p className="mt-2 text-gray-600">
          Step-by-step tutorials and how-to guides for __TITLE__.
        </p>
      </div>

      {guides.length === 0 ? (
        <div className="text-center py-12">
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            No guides available yet
          </h2>
          <p className="text-gray-600 mb-4">
            Guides will appear here as they become available.
          </p>
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 max-w-md mx-auto">
            <p className="text-sm text-green-800">
              🎯 <strong>Coming soon:</strong> Interactive tutorials and 
              step-by-step guides to help you master __TITLE__.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {guides.map((guide) => (
            <div
              key={guide.slug}
              className="border border-gray-200 rounded-lg p-6 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="text-xl font-semibold text-gray-900 mb-2">
                    {guide.title}
                  </h3>
                  {guide.summary && (
                    <p className="text-gray-600 mb-4">{guide.summary}</p>
                  )}
                  {guide.tags && guide.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-4">
                      {guide.tags.map((tag, index) => (
                        <span
                          key={index}
                          className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="ml-4 flex-shrink-0">
                  {guide.level && (
                    <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                      guide.level === 1 
                        ? 'bg-blue-100 text-blue-800'
                        : guide.level === 2
                        ? 'bg-yellow-100 text-yellow-800'
                        : 'bg-red-100 text-red-800'
                    }`}>
                      {guide.level === 1 ? 'Beginner' : guide.level === 2 ? 'Intermediate' : 'Advanced'}
                    </span>
                  )}
                </div>
              </div>
              <div className="text-sm text-blue-600 font-medium">
                Start guide →
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
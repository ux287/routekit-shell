import React, { useEffect, useState } from 'react';
import { loadBlogPosts, type BlogPost } from '../utils/contentLoader';

export default function BlogPage() {
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchPosts() {
      try {
        const postsData = await loadBlogPosts();
        setPosts(postsData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load blog posts');
      } finally {
        setLoading(false);
      }
    }
    
    fetchPosts();
  }, []);

  if (loading) {
    return (
      <div className="px-4 py-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-2 text-gray-600">Loading blog posts...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-8">
        <div className="text-center">
          <p className="text-red-600">Error loading blog posts: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Blog</h1>
        <p className="mt-2 text-gray-600">
          Latest updates, tutorials, and insights from the __TITLE__ team.
        </p>
      </div>

      {posts.length === 0 ? (
        <div className="text-center py-12">
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            No blog posts yet
          </h2>
          <p className="text-gray-600 mb-4">
            Check back soon for updates and insights.
          </p>
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 max-w-md mx-auto">
            <p className="text-sm text-purple-800">
              📝 <strong>Stay tuned:</strong> We'll be sharing updates, 
              tutorials, and best practices as we build together.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {posts.map((post) => (
            <article
              key={post.slug}
              className="border-b border-gray-200 pb-8 last:border-b-0"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h2 className="text-2xl font-bold text-gray-900 mb-2">
                    {post.title}
                  </h2>
                  {post.summary && (
                    <p className="text-gray-600 mb-4 text-lg">{post.summary}</p>
                  )}
                  <div className="flex items-center text-sm text-gray-500 mb-4">
                    {post.author && <span>{post.author}</span>}
                    {post.author && post.created && <span className="mx-2">•</span>}
                    {post.created && (
                      <time dateTime={post.created}>
                        {new Date(post.created).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric'
                        })}
                      </time>
                    )}
                  </div>
                  {post.tags && post.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-4">
                      {post.tags.map((tag, index) => (
                        <span
                          key={index}
                          className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="text-sm text-blue-600 font-medium">
                Read full post →
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
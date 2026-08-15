import matter from 'gray-matter';
import { marked } from 'marked';

// Generic content item interface
export interface ContentItem {
  title: string;
  slug: string;
  created?: string;
  updated?: string;
  publish?: boolean;
  published?: boolean;
  summary?: string;
  description?: string;
  tags?: string[];
  category?: string;
  author?: string;
  order?: number;
  
  // Documentation-specific fields
  section?: string;
  subsection?: string;
  level?: number;
  toc?: boolean; // Table of contents
  
  // Content fields
  content?: string;
  html?: string;
  
  // Allow additional fields
  [key: string]: any;
}

export interface ContentConfig {
  type: 'docs' | 'guides' | 'blog';
  indexPath: string;
  filePathPrefix: string;
  sortField: string;
  sortOrder: 'asc' | 'desc';
}

const CONTENT_CONFIGS: Record<string, ContentConfig> = {
  docs: {
    type: 'docs',
    indexPath: '../data/docs-index.json',
    filePathPrefix: '/docs/',
    sortField: 'order',
    sortOrder: 'asc'
  },
  guides: {
    type: 'guides',
    indexPath: '../data/guides-index.json', 
    filePathPrefix: '/guides/',
    sortField: 'order',
    sortOrder: 'asc'
  },
  blog: {
    type: 'blog',
    indexPath: '../data/blog-index.json',
    filePathPrefix: '/blog/',
    sortField: 'created',
    sortOrder: 'desc'
  }
};

// Unified file loader with support for different sources
async function loadContentFile(filename: string, prefix: string = '/notes/'): Promise<string> {
  const url = filename.startsWith('http') ? filename : `${prefix}${filename}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load content file: ${filename} (${response.status})`);
    }
    return await response.text();
  } catch (error) {
    console.error(`Error loading content file: ${filename}`, error);
    throw error;
  }
}

// Dynamic index loader with fallback for missing files
async function loadContentIndex(indexPath: string): Promise<ContentItem[]> {
  try {
    if (indexPath.includes('docs-index.json')) {
      try {
        const { default: docsIndex } = await import('../data/docs-index.json');
        return docsIndex;
      } catch {
        console.warn('docs-index.json not found, returning empty array');
        return [];
      }
    } else if (indexPath.includes('guides-index.json')) {
      try {
        const { default: guidesIndex } = await import('../data/guides-index.json');
        return guidesIndex;
      } catch {
        console.warn('guides-index.json not found, returning empty array');
        return [];
      }
    } else if (indexPath.includes('blog-index.json')) {
      try {
        const { default: blogIndex } = await import('../data/blog-index.json');
        return blogIndex;
      } catch {
        console.warn('blog-index.json not found, returning empty array');
        return [];
      }
    }
    throw new Error(`Unknown index path: ${indexPath}`);
  } catch (error) {
    console.error(`Error loading content index from ${indexPath}:`, error);
    return [];
  }
}

// Check if item should be published
function isPublished(item: ContentItem): boolean {
  return Boolean(item.publish || item.published);
}

// Get sorting value for an item
function getSortValue(item: ContentItem, sortField: string): string | number {
  if (sortField === 'order' && typeof item.order === 'number') {
    return item.order;
  }
  return item[sortField] || item.created || item.updated || '1970-01-01';
}

// Generic content list loader
export async function loadContentList(contentType: string): Promise<ContentItem[]> {
  const config = CONTENT_CONFIGS[contentType];
  if (!config) {
    throw new Error(`Unknown content type: ${contentType}`);
  }

  try {
    const contentIndex = await loadContentIndex(config.indexPath);
    const items: ContentItem[] = [];
    
    for (const itemMeta of contentIndex) {
      try {
        // Skip unpublished items early
        if (!isPublished(itemMeta)) {
          continue;
        }
        
        // If no filename, use the JSON data directly
        if (!itemMeta.filename) {
          items.push(itemMeta);
          continue;
        }
        
        // Load markdown content if filename exists
        try {
          const markdown = await loadContentFile(itemMeta.filename, config.filePathPrefix);
          const { data, content } = matter(markdown);
          
          // Only include published items
          if (data.publish || itemMeta.published || itemMeta.publish) {
            items.push({
              ...itemMeta, // Base metadata
              ...data,     // Frontmatter overrides
              content,     // Raw markdown content
              slug: itemMeta.slug || data.slug
            });
          }
        } catch (fileError) {
          console.warn(`Could not load markdown for ${itemMeta.slug}, using JSON data only`);
          // Fallback to JSON data if markdown fails to load
          items.push(itemMeta);
        }
      } catch (itemError) {
        console.error(`Error processing ${contentType} item ${itemMeta.slug}:`, itemError);
      }
    }
    
    // Sort items
    items.sort((a, b) => {
      const valueA = getSortValue(a, config.sortField);
      const valueB = getSortValue(b, config.sortField);
      
      // Handle numeric sorting (for order field)
      if (typeof valueA === 'number' && typeof valueB === 'number') {
        return config.sortOrder === 'desc' ? valueB - valueA : valueA - valueB;
      }
      
      // Handle date/string sorting
      const stringA = String(valueA);
      const stringB = String(valueB);
      
      if (config.sortOrder === 'desc') {
        return stringB.localeCompare(stringA);
      }
      return stringA.localeCompare(stringB);
    });
    
    return items;
  } catch (error) {
    console.error(`Error loading ${contentType} list:`, error);
    return [];
  }
}

// Generic content detail loader
export async function loadContentItem(contentType: string, slug: string): Promise<ContentItem | null> {
  const config = CONTENT_CONFIGS[contentType];
  if (!config) {
    throw new Error(`Unknown content type: ${contentType}`);
  }

  try {
    const contentIndex = await loadContentIndex(config.indexPath);
    const itemMeta = contentIndex.find(item => item.slug === slug);
    
    if (!itemMeta) return null;
    
    // If no filename, return JSON data as-is
    if (!itemMeta.filename) {
      return itemMeta;
    }
    
    // Load and parse markdown content
    try {
      const markdown = await loadContentFile(itemMeta.filename, config.filePathPrefix);
      const { data, content } = matter(markdown);
      const html = await marked(content);
      
      return {
        ...itemMeta, // Base metadata
        ...data,     // Frontmatter overrides
        content,     // Raw markdown content
        html,        // Rendered HTML
        slug: itemMeta.slug || data.slug
      };
    } catch (fileError) {
      console.warn(`Could not load markdown for ${slug}, returning JSON data only`);
      return itemMeta;
    }
  } catch (error) {
    console.error(`Error loading ${contentType} item ${slug}:`, error);
    return null;
  }
}

// Convenience functions for documentation
export const loadDocs = () => loadContentList('docs');
export const loadDoc = (slug: string) => loadContentItem('docs', slug);
export const loadGuides = () => loadContentList('guides');  
export const loadGuide = (slug: string) => loadContentItem('guides', slug);
export const loadBlogPosts = () => loadContentList('blog');
export const loadBlogPost = (slug: string) => loadContentItem('blog', slug);

// Helper function to organize docs by section
export async function loadDocsBySection(): Promise<Record<string, ContentItem[]>> {
  const docs = await loadDocs();
  const sections: Record<string, ContentItem[]> = {};
  
  docs.forEach(doc => {
    const section = doc.section || 'General';
    if (!sections[section]) {
      sections[section] = [];
    }
    sections[section].push(doc);
  });
  
  return sections;
}

// Type aliases for clarity
export type DocItem = ContentItem;
export type GuideItem = ContentItem;
export type BlogPost = ContentItem;
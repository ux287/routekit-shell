import React from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';

const navigation = [
  { name: 'Home', href: '/' },
  { name: 'Docs', href: '/docs' },
  { name: 'Guides', href: '/guides' },
  { name: 'Blog', href: '/blog' },
  { name: 'Demo', href: '/demo' },
];

export default function Layout() {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-white">
      <nav className="bg-gray-900 text-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <Link to="/" className="text-xl font-bold">
                  __TITLE__
                </Link>
              </div>
              <div className="hidden md:block">
                <div className="ml-10 flex items-baseline space-x-4">
                  {navigation.map((item) => {
                    const isActive = location.pathname === item.href || 
                      (item.href !== '/' && location.pathname.startsWith(item.href));
                    return (
                      <Link
                        key={item.name}
                        to={item.href}
                        className={`px-3 py-2 rounded-md text-sm font-medium ${
                          isActive
                            ? 'bg-gray-700 text-white'
                            : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                        }`}
                      >
                        {item.name}
                      </Link>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-7xl py-6 sm:px-6 lg:px-8">
        <Outlet />
      </main>

      <footer className="bg-gray-50 mt-12">
        <div className="mx-auto max-w-7xl py-8 px-4 sm:px-6 lg:px-8">
          <div className="text-center text-gray-600">
            <p>&copy; 2024 __TITLE__. Built with RouteKit.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
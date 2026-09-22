'use client';

import { ClusterDetail } from '../lib/mockData';

interface ClusterDetailPanelProps {
  cluster: ClusterDetail | null;
  onClose: () => void;
  isLoading?: boolean;
}

// Minimal color palette for source badges
const sourceColors: Record<string, string> = {
  'BBC News': 'bg-red-100 text-red-800 border-red-200',
  'NY Times': 'bg-slate-100 text-slate-800 border-slate-300',
  'Al Jazeera': 'bg-orange-100 text-orange-800 border-orange-200',
  'The Guardian': 'bg-blue-100 text-blue-800 border-blue-200',
  'NPR': 'bg-emerald-100 text-emerald-800 border-emerald-200',
};

const getSourceColor = (source: string) => {
  return sourceColors[source] || 'bg-gray-100 text-gray-800 border-gray-200';
};

export function ClusterDetailPanel({ cluster, onClose, isLoading = false }: ClusterDetailPanelProps) {
  // Using a side panel rather than a modal so the user can keep context of the timeline 
  // while reading through articles in a cluster, without feeling completely blocked.
  return (
    <aside 
      className={`
        fixed top-0 right-0 h-[100dvh] w-full sm:w-[400px] bg-white shadow-2xl z-50
        transform transition-transform duration-300 ease-in-out border-l border-slate-200
        ${cluster || isLoading ? 'translate-x-0' : 'translate-x-full'}
      `}
    >
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-start justify-between p-6 border-b border-slate-100 min-h-[80px]">
          <h2 className="text-xl font-semibold text-slate-900 leading-tight pr-4 tracking-tight">
            {isLoading ? (
              <div className="h-6 bg-slate-200 rounded w-3/4 animate-pulse"></div>
            ) : (
              cluster?.label
            )}
          </h2>
          <button 
            onClick={onClose}
            className="p-2 -mr-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors shrink-0"
            aria-label="Close panel"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Articles List */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-50">
          {isLoading ? (
            <div className="space-y-4">
              <div className="h-4 bg-slate-200 rounded w-16 mb-6 animate-pulse"></div>
              {[1, 2, 3].map(i => (
                <div key={i} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                  <div className="flex justify-between mb-3">
                    <div className="h-4 bg-slate-200 rounded w-20 animate-pulse"></div>
                    <div className="h-3 bg-slate-200 rounded w-16 animate-pulse"></div>
                  </div>
                  <div className="h-4 bg-slate-200 rounded w-full mb-2 animate-pulse"></div>
                  <div className="h-4 bg-slate-200 rounded w-2/3 animate-pulse"></div>
                </div>
              ))}
            </div>
          ) : cluster ? (
            <>
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">
                {cluster.articles.length} {cluster.articles.length === 1 ? 'Article' : 'Articles'}
              </h3>
              
              <div className="space-y-4">
                {cluster.articles.map((article) => (
                  <a 
                    key={article.id}
                    href={article.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block bg-white p-5 rounded-xl border border-slate-200 shadow-sm hover:shadow-md hover:border-slate-300 transition-all group"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${getSourceColor(article.source)}`}>
                        {article.source}
                      </span>
                      <span className="text-xs text-slate-400">
                        {article.publishedAt ? new Date(article.publishedAt).toLocaleDateString(undefined, {
                          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
                        }) : 'Unknown date'}
                      </span>
                    </div>
                    <h4 className="text-[15px] font-medium text-slate-900 leading-snug group-hover:text-blue-600 transition-colors">
                      {article.headline}
                    </h4>
                    <div className="mt-3 text-xs font-medium text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity flex items-center">
                      Read full story
                      <svg className="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                      </svg>
                    </div>
                  </a>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

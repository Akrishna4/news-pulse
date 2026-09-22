'use client';

import { useState, useMemo, useEffect } from 'react';
import { Timeline } from './components/Timeline';
import { SourceFilter } from './components/SourceFilter';
import { RefreshButton } from './components/RefreshButton';
import { ClusterDetailPanel } from './components/ClusterDetailPanel';
import { fetchTimeline, fetchClusterDetail } from './lib/api';
import { usePolling } from './hooks/usePolling';
import { TimelineResponse, ClusterDetail } from './lib/mockData';

export default function Home() {
  const [selectedClusterId, setSelectedClusterId] = useState<number | null>(null);
  const [timelineData, setTimelineData] = useState<TimelineResponse | null>(null);
  
  // States for fetching
  const [viewState, setViewState] = useState<'ready' | 'loading' | 'empty' | 'error'>('loading');
  const [selectedClusterDetail, setSelectedClusterDetail] = useState<ClusterDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadTimeline = async () => {
    try {
      setViewState('loading');
      const data = await fetchTimeline();
      setTimelineData(data);
      if (data.clusters.length === 0) {
        setViewState('empty');
      } else {
        setViewState('ready');
      }
    } catch (error) {
      console.error('Failed to load timeline:', error);
      setViewState('error');
    }
  };

  useEffect(() => {
    loadTimeline();
  }, []);

  const { state: pollingState, errorMessage, startPolling } = usePolling(() => {
    // When polling completes successfully, reload timeline
    loadTimeline();
  });

  // Extract all unique sources from timeline data
  const allSources = useMemo(() => {
    if (!timelineData) return [];
    const sources = new Set<string>();
    timelineData.clusters.forEach(c => c.sources.forEach(s => sources.add(s)));
    return Array.from(sources).sort();
  }, [timelineData]);

  // Handle initialization of selectedSources
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  useEffect(() => {
    if (allSources.length > 0 && selectedSources.length === 0) {
      setSelectedSources(allSources);
    }
  }, [allSources, selectedSources.length]);

  // Filter clusters client-side based on selected sources
  const filteredClusters = useMemo(() => {
    if (!timelineData) return [];
    return timelineData.clusters.filter(c => 
      c.sources.some(s => selectedSources.includes(s))
    );
  }, [timelineData, selectedSources]);

  // Load cluster detail when selected
  useEffect(() => {
    if (!selectedClusterId) {
      setSelectedClusterDetail(null);
      return;
    }

    let isMounted = true;
    setDetailLoading(true);

    fetchClusterDetail(selectedClusterId)
      .then(detail => {
        if (isMounted) {
          setSelectedClusterDetail(detail);
          setDetailLoading(false);
        }
      })
      .catch(err => {
        console.error('Failed to load detail:', err);
        if (isMounted) setDetailLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [selectedClusterId]);


  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 overflow-x-hidden">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center py-4 space-y-4 sm:space-y-0">
            <div className="flex items-center space-x-3">
              <div className="bg-blue-600 p-2 rounded-lg">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9.5a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                News Pulse
              </h1>
            </div>

            <div className="flex items-center space-x-6">
              {allSources.length > 0 && (
                <SourceFilter 
                  sources={allSources}
                  selectedSources={selectedSources}
                  onChange={setSelectedSources}
                />
              )}
              <RefreshButton 
                onRefreshStart={startPolling} 
                state={pollingState}
                errorMessage={errorMessage}
              />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 relative">
        <div className="mt-8">
          {viewState === 'loading' && (
            <div className="flex flex-col items-center justify-center h-64 bg-white border border-slate-200 rounded-xl shadow-sm">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-4"></div>
              <p className="text-slate-500 font-medium animate-pulse">Loading timeline...</p>
            </div>
          )}

          {viewState === 'empty' && (
            <div className="flex flex-col items-center justify-center h-64 bg-white border border-slate-200 rounded-xl shadow-sm">
              <div className="bg-slate-100 p-3 rounded-full mb-3">
                <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-slate-900">No articles yet</h3>
              <p className="text-sm text-slate-500 mt-1">Click refresh to fetch the latest news.</p>
            </div>
          )}

          {viewState === 'error' && (
            <div className="flex flex-col items-center justify-center h-64 bg-red-50 border border-red-200 rounded-xl shadow-sm">
              <svg className="w-8 h-8 text-red-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <h3 className="text-lg font-medium text-red-800">Failed to load timeline</h3>
              <p className="text-sm text-red-600 mt-1">Please ensure the backend is running and try again.</p>
              <button 
                onClick={loadTimeline}
                className="mt-4 px-4 py-2 bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors text-sm font-medium"
              >
                Retry
              </button>
            </div>
          )}

          {viewState === 'ready' && timelineData && (
            <div className="relative">
              <Timeline 
                clusters={filteredClusters} 
                range={timelineData.range}
                onClusterClick={(id) => setSelectedClusterId(id)}
                selectedClusterId={selectedClusterId}
              />
            </div>
          )}
        </div>
      </main>

      {/* Side Panel Overlay */}
      {selectedClusterId && (
        <div 
          className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm z-40 transition-opacity"
          onClick={() => setSelectedClusterId(null)}
        />
      )}

      {/* Side Panel */}
      <div className="relative z-50">
        <ClusterDetailPanel 
          cluster={selectedClusterDetail} 
          onClose={() => setSelectedClusterId(null)} 
          isLoading={detailLoading}
        />
      </div>
    </div>
  );
}

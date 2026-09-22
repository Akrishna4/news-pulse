'use client';

import { PollingState } from '../hooks/usePolling';
import { useEffect, useState } from 'react';

interface RefreshButtonProps {
  onRefreshStart: () => void;
  state: PollingState;
  errorMessage: string | null;
}

export function RefreshButton({ onRefreshStart, state, errorMessage }: RefreshButtonProps) {
  // Local state to hold the 'done' state briefly before resetting to 'idle'
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    if (state === 'completed') {
      setShowDone(true);
      const t = setTimeout(() => setShowDone(false), 3000);
      return () => clearTimeout(t);
    } else {
      setShowDone(false);
    }
  }, [state]);

  // Determine visual state
  let visualState = 'idle';
  if (state === 'running') visualState = 'refreshing';
  else if (showDone) visualState = 'done';
  else if (state === 'error' || state === 'timeout') visualState = 'error';

  return (
    <div className="relative flex flex-col items-end">
      <button
        onClick={onRefreshStart}
        disabled={visualState === 'refreshing'}
        className={`
          relative overflow-hidden flex items-center justify-center px-4 py-2 rounded-lg font-medium text-sm
          transition-all duration-300 min-w-[130px]
          ${visualState === 'idle' ? 'bg-slate-900 text-white hover:bg-slate-800' : ''}
          ${visualState === 'refreshing' ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : ''}
          ${visualState === 'done' ? 'bg-green-500 text-white' : ''}
          ${visualState === 'error' ? 'bg-red-500 text-white' : ''}
        `}
      >
        {visualState === 'idle' && <span>Refresh News</span>}
        
        {visualState === 'refreshing' && (
          <span className="flex items-center space-x-2">
            <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span>Syncing...</span>
          </span>
        )}

        {visualState === 'done' && (
          <span className="flex items-center space-x-1 animate-in fade-in zoom-in duration-300">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
            </svg>
            <span>Updated</span>
          </span>
        )}

        {visualState === 'error' && <span>Failed</span>}
      </button>

      {/* Show tooltip for errors/timeouts */}
      {(state === 'error' || state === 'timeout') && errorMessage && (
        <div className="absolute top-full mt-2 w-64 p-2 bg-red-100 text-red-800 text-xs rounded border border-red-200 z-50 animate-in fade-in slide-in-from-top-2">
          {errorMessage}
        </div>
      )}
    </div>
  );
}

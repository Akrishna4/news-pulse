import { useState, useCallback, useRef } from 'react';
import { triggerIngest, fetchIngestStatus } from '../lib/api';

export type PollingState = 'idle' | 'running' | 'completed' | 'error' | 'timeout';

interface UsePollingReturn {
  state: PollingState;
  errorMessage: string | null;
  startPolling: () => void;
  resetState: () => void;
}

export function usePolling(onComplete: () => void): UsePollingReturn {
  const [state, setState] = useState<PollingState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const activeJobIdRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  const resetState = useCallback(() => {
    cleanup();
    setState('idle');
    setErrorMessage(null);
    activeJobIdRef.current = null;
  }, [cleanup]);

  const doPoll = useCallback(async (jobId: string) => {
    try {
      const statusRes = await fetchIngestStatus(jobId);
      
      if (statusRes.status === 'completed') {
        cleanup();
        setState('completed');
        onComplete();
      } else if (statusRes.status === 'failed') {
        cleanup();
        setState('error');
        setErrorMessage(statusRes.errorMessage || 'Ingestion failed on the server.');
      }
      // if 'running', do nothing (interval continues)
    } catch (err: any) {
      // Just log poll failures, don't immediately crash the whole polling process
      // It might be a temporary network blip
      console.error('Poll fetch failed:', err);
    }
  }, [cleanup, onComplete]);

  const startPolling = useCallback(async () => {
    if (state === 'running') return;
    
    resetState();
    setState('running');

    let targetJobId: string | null = null;

    try {
      const res = await triggerIngest();
      targetJobId = res.jobId;
    } catch (error: any) {
      if (error.name === 'ApiError' && error.status === 409) {
        // 409 Conflict: A job is already running.
        // The API returns { error: 'Ingestion already running', jobId: '...' } 
        // We can recover and just start polling that job.
        if (error.data && error.data.jobId) {
          targetJobId = error.data.jobId;
          // You might also want to surface a toast here, but we will just seamlessly attach
          console.log('Attached to already running job:', targetJobId);
        } else {
          setState('error');
          setErrorMessage('An ingestion is already in progress, but the job ID could not be retrieved.');
          return;
        }
      } else {
        setState('error');
        setErrorMessage(error.message || 'Failed to trigger ingestion.');
        return;
      }
    }

    if (!targetJobId) {
       setState('error');
       setErrorMessage('No job ID returned from server.');
       return;
    }

    activeJobIdRef.current = targetJobId;

    // Start polling every 2.5 seconds
    pollIntervalRef.current = setInterval(() => {
      if (activeJobIdRef.current) {
        doPoll(activeJobIdRef.current);
      }
    }, 2500);

    // Cap total polling duration at ~2 minutes
    timeoutRef.current = setTimeout(() => {
      // If we haven't completed or failed by now
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      setState('timeout');
      setErrorMessage('Ingestion is taking longer than expected. It may still complete in the background.');
    }, 120000);

  }, [state, resetState, doPoll]);

  return { state, errorMessage, startPolling, resetState };
}

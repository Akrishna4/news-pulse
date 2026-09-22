import { TimelineResponse, ClusterDetail } from './mockData';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

class ApiError extends Error {
  status: number;
  data: any;
  
  constructor(message: string, status: number, data?: any) {
    super(message);
    this.status = status;
    this.data = data;
    this.name = 'ApiError';
  }
}

async function fetchJson<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${API_URL}${endpoint}`;
  
  try {
    const response = await fetch(url, options);
    
    // Attempt to parse JSON safely regardless of status code
    let data;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    }
    
    if (!response.ok) {
      throw new ApiError(`API Error ${response.status}: ${response.statusText}`, response.status, data);
    }
    
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    // Network or parsing error
    throw new Error(`Network error or failed to parse response: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function fetchTimeline(): Promise<TimelineResponse> {
  return fetchJson<TimelineResponse>('/timeline');
}

export async function fetchClusterDetail(id: number): Promise<ClusterDetail> {
  return fetchJson<ClusterDetail>(`/clusters/${id}`);
}

export interface IngestTriggerResponse {
  jobId: string;
  message?: string;
  status?: string;
}

export async function triggerIngest(): Promise<IngestTriggerResponse> {
  return fetchJson<IngestTriggerResponse>('/ingest/trigger', { method: 'POST' });
}

export interface IngestStatusResponse {
  id: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  articlesFound: number | null;
  articlesNew: number | null;
  errorMessage: string | null;
}

export async function fetchIngestStatus(jobId: string): Promise<IngestStatusResponse> {
  return fetchJson<IngestStatusResponse>(`/ingest/status/${jobId}`);
}

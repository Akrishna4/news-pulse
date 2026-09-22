export interface Article {
  id: number;
  headline: string;
  source: string;
  url: string;
  publishedAt: string | null;
}

export interface ClusterDetail {
  id: number;
  label: string;
  articles: Article[];
}

export interface TimelineCluster {
  id: number;
  label: string;
  startTime: string | null;
  endTime: string | null;
  articleCount: number;
  sources: string[];
}

export interface TimelineResponse {
  clusters: TimelineCluster[];
  range: {
    earliest: string;
    latest: string;
  } | null;
}


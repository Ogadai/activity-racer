export interface HealthResponse {
  status: 'ok';
  service: string;
  region: string;
  timestamp: string;
}

export interface RuntimeConfig {
  apiUrl: string;
  region: string;
}

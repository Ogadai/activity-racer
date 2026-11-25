export interface HealthResponse {
  status: 'ok';
  service: string;
  region: string;
  timestamp: string;
}

export interface RuntimeConfig {
  apiUrl: string;
  region: string;
  userPoolId?: string;
  userPoolClientId?: string;
  cognitoDomain?: string;
  googleAuthEnabled?: boolean;
  callbackPath?: string;
  logoutPath?: string;
  hostingMode?: 'cloudfront' | 'apigw-lambda-s3';
  aiCommentaryEnabled?: boolean;
}

export interface ScoringTargets {
  dailyStepTarget: number;
  dailyCalorieTarget: number;
  stepWeight: number;
  calorieWeight: number;
}

export interface PlayerProfile extends ScoringTargets {
  userId: string;
  displayName: string;
  playerSlug: string;
  bikeColor: string;
  webhookApiKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpdatePlayerProfileRequest {
  displayName?: string;
  playerSlug?: string;
  bikeColor?: string;
  dailyStepTarget?: number;
  dailyCalorieTarget?: number;
  stepWeight?: number;
  calorieWeight?: number;
  rotateWebhookApiKey?: boolean;
}

export type GroupRole = 'OWNER' | 'MEMBER';

export interface GroupSummary {
  groupId: string;
  name: string;
  inviteCode: string;
  role: GroupRole;
  createdBy: string;
  createdAt: string;
  joinedAt: string;
}

export interface CreateGroupRequest {
  name: string;
}

export interface JoinGroupRequest {
  inviteCode: string;
}

export interface GroupsListResponse {
  groups: GroupSummary[];
}

export interface DailyStat {
  date: string;
  steps: number;
  activeCalories: number;
  updatedAt: string;
  source: string;
}

export interface IngestStatsRequest {
  playerSlug: string;
  date?: string;
  steps: number;
  activeCalories: number;
  source?: string;
}

export interface DailyScoreBreakdown {
  date: string;
  steps: number;
  activeCalories: number;
  stepPct: number;
  caloriePct: number;
  weightedScorePct: number;
  isOverdrive: boolean;
}

export interface IngestStatsResponse {
  playerSlug: string;
  stat: DailyStat;
  dailyScore: DailyScoreBreakdown;
}

export type RaceRange = 'daily' | 'weekly';

export interface RaceStanding {
  rank: number;
  userId: string;
  displayName: string;
  playerSlug: string;
  bikeColor: string;
  isCurrentUser: boolean;
  isLeader: boolean;
  isOverdrive: boolean;
  weightedScorePct: number;
  stepPct: number;
  caloriePct: number;
  steps: number;
  activeCalories: number;
  stepTarget: number;
  calorieTarget: number;
  stepWeight: number;
  calorieWeight: number;
  daysLogged: number;
  lastUpdatedAt: string | null;
  dailyBreakdown: DailyScoreBreakdown[];
}

export interface RaceResponse {
  group: {
    groupId: string;
    name: string;
    inviteCode: string;
  };
  range: RaceRange;
  date: string;
  startDate: string;
  endDate: string;
  standings: RaceStanding[];
  generatedAt: string;
}

export interface RaceCommentaryDay {
  date: string;
  dayLabel: string;
  commentary: string;
}

export interface RaceCommentaryResponse {
  groupId: string;
  range: RaceRange;
  startDate: string;
  endDate: string;
  headline: string;
  days: RaceCommentaryDay[];
  summary: string;
  model: string;
  generatedAt: string;
  cached: boolean;
}

export interface ApiErrorResponse {
  error: string;
  details?: string;
}

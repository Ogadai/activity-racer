import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateGroupRequest,
  GroupSummary,
  GroupsListResponse,
  HealthResponse,
  JoinGroupRequest,
  PlayerProfile,
  RaceCommentaryResponse,
  RaceRange,
  RaceResponse,
  UpdatePlayerProfileRequest,
} from '@activity-racer/shared';
import { useAuth } from '../auth/AuthContext';
import { apiRequest } from './client';

export const queryKeys = {
  health: ['health'] as const,
  profile: ['profile'] as const,
  groups: ['groups'] as const,
  race: (groupId: string, range: RaceRange, date: string) =>
    ['race', groupId, range, date] as const,
  commentary: (groupId: string, range: RaceRange, startDate: string) =>
    ['commentary', groupId, range, startDate] as const,
};

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => apiRequest<HealthResponse>('/health', { signal }),
    staleTime: 30_000,
    retry: 1,
  });
}

export function useProfile() {
  const { status, getValidToken } = useAuth();
  return useQuery({
    queryKey: queryKeys.profile,
    queryFn: ({ signal }) =>
      apiRequest<PlayerProfile>('/me', { getToken: getValidToken, signal }),
    enabled: status === 'authenticated',
    staleTime: 60_000,
  });
}

export function useUpdateProfile() {
  const { getValidToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: UpdatePlayerProfileRequest) =>
      apiRequest<PlayerProfile>('/me', {
        method: 'PUT',
        body: payload,
        getToken: getValidToken,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.profile, updated);
      void queryClient.invalidateQueries({ queryKey: ['race'] });
    },
  });
}

export function useGroups() {
  const { status, getValidToken } = useAuth();
  return useQuery({
    queryKey: queryKeys.groups,
    queryFn: ({ signal }) =>
      apiRequest<GroupsListResponse>('/groups', { getToken: getValidToken, signal }),
    enabled: status === 'authenticated',
    staleTime: 30_000,
  });
}

export function useCreateGroup() {
  const { getValidToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateGroupRequest) =>
      apiRequest<GroupSummary>('/groups', {
        method: 'POST',
        body: payload,
        getToken: getValidToken,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
    },
  });
}

export function useJoinGroup() {
  const { getValidToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: JoinGroupRequest) =>
      apiRequest<GroupSummary>('/groups/join', {
        method: 'POST',
        body: payload,
        getToken: getValidToken,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
    },
  });
}

export function useRace(groupId: string | undefined, range: RaceRange, date: string) {
  const { status, getValidToken } = useAuth();
  return useQuery({
    queryKey: queryKeys.race(groupId ?? '', range, date),
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams({ range, date }).toString();
      return apiRequest<RaceResponse>(`/groups/${encodeURIComponent(groupId!)}/race?${qs}`, {
        getToken: getValidToken,
        signal,
      });
    },
    enabled: status === 'authenticated' && Boolean(groupId),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useRaceCommentary(
  groupId: string | undefined,
  range: RaceRange,
  anchorDate: string,
  startDate: string | undefined,
  enabled: boolean,
) {
  const { status, getValidToken } = useAuth();
  return useQuery({
    queryKey: queryKeys.commentary(groupId ?? '', range, startDate ?? anchorDate),
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams({ range, date: anchorDate }).toString();
      return apiRequest<RaceCommentaryResponse>(
        `/groups/${encodeURIComponent(groupId!)}/commentary?${qs}`,
        {
          getToken: getValidToken,
          signal,
        },
      );
    },
    enabled: status === 'authenticated' && Boolean(groupId) && Boolean(startDate) && enabled,
    staleTime: 5 * 60 * 1000, // 5-minute client cache aligned with server cooldown
    refetchOnWindowFocus: false,
    retry: false,
  });
}

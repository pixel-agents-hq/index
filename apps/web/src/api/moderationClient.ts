/** Moderator layout browsing, the Admin read-only user directory, and the admin audit log. */
import { apiRequest, toQueryString } from './client';
import type {
  CreatedWebhookSubscriptionResponse,
  ListAdminUsersResponse,
  ListAuditLogParams,
  ListAuditLogResponse,
  ListModerationLayoutsParams,
  ListOwnerLayoutsResponse,
  ListWebhookSubscriptionsResponse,
  Role,
  WebhookSubscriptionView,
} from './types';

export function getModerationLayouts(
  params: ListModerationLayoutsParams,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ListOwnerLayoutsResponse> {
  return apiRequest(`/api/v1/moderation/layouts${toQueryString(params)}`, { accessToken, signal });
}

export function getAdminUsers(
  params: { limit?: number; cursor?: string; q?: string; capability?: Role },
  accessToken: string,
  signal?: AbortSignal,
): Promise<ListAdminUsersResponse> {
  return apiRequest(`/api/v1/admin/users${toQueryString(params)}`, { accessToken, signal });
}

export function getAuditLog(
  params: ListAuditLogParams,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ListAuditLogResponse> {
  return apiRequest(`/api/v1/admin/moderation-actions${toQueryString(params)}`, { accessToken, signal });
}

export function getWebhookSubscriptions(
  accessToken: string,
  signal?: AbortSignal,
): Promise<ListWebhookSubscriptionsResponse> {
  return apiRequest('/api/v1/moderation/webhook-subscriptions', { accessToken, signal });
}

export function createWebhookSubscription(
  body: { name: string; endpointUrl: string },
  accessToken: string,
): Promise<CreatedWebhookSubscriptionResponse> {
  return apiRequest('/api/v1/moderation/webhook-subscriptions', {
    method: 'POST',
    body,
    accessToken,
  });
}

export function rotateWebhookSubscriptionSecret(
  id: string,
  accessToken: string,
): Promise<CreatedWebhookSubscriptionResponse> {
  return apiRequest(`/api/v1/moderation/webhook-subscriptions/${encodeURIComponent(id)}/rotate`, {
    method: 'POST',
    accessToken,
  });
}

export function setWebhookSubscriptionActive(
  id: string,
  active: boolean,
  accessToken: string,
): Promise<WebhookSubscriptionView> {
  return apiRequest(`/api/v1/admin/webhook-subscriptions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { active },
    accessToken,
  });
}

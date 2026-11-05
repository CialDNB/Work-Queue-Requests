// WHY A PRIVATE HTTP SERVICE CALL FAILED — a fixed vocabulary, never the request.
//
// src/data/privateServices.ts logs one line per failed call (`private_service_failed`) with the
// service NAME and one of these literals. The host, the path, the credential and any error message
// stay out of it: a network error's message can carry the URL, and Workers Logs keep every line.
// It lives here, with no imports, so src/platform/logEvent.ts can register the enum without
// importing the transport that logs through it.
//
// `timeout` and `network` are the two an integration module may retry. Every other reason is
// configuration or a programming error, and retrying it only repeats the refusal — except
// `aborted`, which is the caller's own signal firing, and not the service's fault.
export const PRIVATE_SERVICE_FAILURES = [
  'unregistered',
  'binding_missing',
  'host_invalid',
  'credential_missing',
  'request_refused',
  'header_refused',
  'timeout',
  'network',
  'aborted',
  'redirect_refused',
] as const;

export type PrivateServiceFailure = (typeof PRIVATE_SERVICE_FAILURES)[number];

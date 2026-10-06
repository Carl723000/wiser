import { createHash } from 'node:crypto';
import {
  CompleteUploadSessionInputSchema,
  CompleteUploadSessionOutputSchema,
  CreateIngestionInputSchema,
  CreateIngestionOutputSchema,
  CreateUploadSessionInputSchema,
  CreateUploadSessionOutputSchema,
  GetIngestionOutputSchema,
  OperationEventPageSchema,
  OperationSchema,
  SourceRegistrationManifestSchema,
  candidateSavedReferenceKey,
} from '@wiser/data-contracts';
import {
  PlatformPurposeSchema,
  PlatformUuidSchema,
} from '@wiser/platform-contracts';
import { CandidateLoadAuthError } from './a12-candidate-load-auth.ts';
import {
  CandidateLoadTransportError,
  candidateLoadConditions,
  canonicalLoadContent,
  readFrozenCandidateInput,
  runCandidateLoadCondition,
  validateLoadReply,
} from './a12-candidate-load-driver.ts';
import { runCandidateLoadTraversalOnce } from './a12-candidate-load-traversal.ts';
import type {
  CandidateLoadAuthCondition,
  CandidateLoadAuthGuard,
} from './a12-candidate-load-auth.ts';
import type { CandidateLoadHttpAdapter } from './a12-candidate-load-http.ts';
import type {
  FrozenCandidateDataset,
  LoadAction,
  LoadConditionResult,
  LoadDataset,
  LoadFailure,
  LoadPorts,
} from './a12-candidate-load-driver.ts';
import type { TraversalIteration } from './a12-candidate-load-traversal.ts';

/** Private test runner input; never a package DTO or server-issued checkpoint. */
export interface A12ArtifactPin {
  readonly path: string;
  readonly sha256: string;
}
export interface A12MemberPin {
  readonly receipt: A12ArtifactPin;
  readonly inventory: A12ArtifactPin;
  readonly standardCapture: A12ArtifactPin;
  readonly preparedAssets: readonly {
    readonly assetId: string;
    readonly artifact: A12ArtifactPin;
    readonly sizeBytes: number;
  }[];
  readonly sourceManifest?: A12ArtifactPin;
}
export interface A12TrackPin {
  readonly dataset: LoadDataset;
  readonly declared: {
    readonly members: number;
    readonly assets: number;
    readonly records: number;
    readonly geometry: number;
  };
  /** Frozen representative candidate for each of the six size/action pairs. */
  readonly sampleMembers: Readonly<Record<LoadAction, number>>;
  readonly members: readonly A12MemberPin[];
}
export interface A12RunInput {
  readonly registrationId: 'GOAL101-A12-20261004';
  readonly scope: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly purpose: string;
  };
  readonly tracks: readonly [
    A12TrackPin & { readonly dataset: 'AUTHENTICATED-REAL' },
    A12TrackPin & { readonly dataset: 'SYNTHETIC-S10' },
  ];
}
export interface A12AdmittedRun {
  readonly scope: A12RunInput['scope'];
  readonly tracks: readonly {
    readonly dataset: LoadDataset;
    readonly sampleMembers: A12TrackPin['sampleMembers'];
    readonly members: readonly FrozenCandidateDataset[];
  }[];
}
export type A12PreflightReason =
  | 'runner_not_implemented'
  | 'configuration'
  | 'artifact_read_failed'
  | 'artifact_hash_mismatch'
  | 'receipt_link_mismatch'
  | 'standard_intake_unverified'
  | 'incomplete_inventory';
export type A12Admission =
  | { readonly status: 'ready'; readonly input: A12AdmittedRun }
  | { readonly status: 'not_run'; readonly reason: A12PreflightReason };
export interface A12DispatchLocation {
  readonly phase: 'condition' | 'traversal';
  readonly trackOrdinal: number;
  readonly memberOrdinal: number;
  readonly conditionOrdinal: number | null;
  readonly roundOrdinal: number | null;
}
export interface A12StandardIntakeCheck {
  /** Parsed existing public request/response captures, kept private. */
  readonly receipt: unknown;
  readonly captureBytes: Uint8Array;
  readonly prepared: readonly {
    readonly assetId: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }[];
  readonly inventory: FrozenCandidateDataset;
}
export interface A12RunnerPorts {
  /** Returns actual bytes. The runner recomputes SHA256; metadata is not proof. */
  readonly readArtifact: (pin: A12ArtifactPin) => Promise<Uint8Array>;
  /**
   * A task-private verifier over actual normal-stack scanner/fingerprint evidence.
   * Generic Operation messages/READY/complete-upload submitted SHA are insufficient.
   * Fake verified results test orchestration only; unknown blocks formal dispatch.
   */
  readonly verifyStandardIntake: (
    check: A12StandardIntakeCheck,
  ) => Promise<'verified' | 'unknown' | 'rejected'>;
  readonly authenticate: (
    scope: A12RunInput['scope'],
  ) => Promise<CandidateLoadAuthGuard>;
  readonly createTransport: (
    condition: CandidateLoadAuthCondition,
    location: A12DispatchLocation,
  ) => CandidateLoadHttpAdapter;
  readonly now: LoadPorts['now'];
  readonly fingerprint: LoadPorts['fingerprint'];
}
export interface A12PageSample {
  readonly trackOrdinal: number;
  readonly roundOrdinal: number;
  readonly memberOrdinal: number;
  readonly pageOrdinal: number;
  readonly action: LoadAction;
  readonly elapsedMs: number | null;
  readonly outcome: 'completed' | LoadFailure;
  readonly wireBytes: number | null;
}
export interface A12RunResult {
  readonly registrationId: 'GOAL101-A12-20261004';
  readonly status: 'passed' | 'failed' | 'not_run';
  readonly reason: A12PreflightReason | LoadFailure | null;
  /** This slice never certifies the 60-minute, memory, first-screen or cold exits. */
  readonly formalA12: 'not_run';
  readonly conditions: readonly {
    readonly trackOrdinal: number;
    readonly memberOrdinal: number;
    readonly ordinal: number;
    readonly result: LoadConditionResult;
  }[];
  readonly rounds: readonly {
    readonly trackOrdinal: number;
    readonly ordinal: number;
    readonly members: readonly {
      readonly memberOrdinal: number;
      readonly result: TraversalIteration;
    }[];
  }[];
  readonly pageSamples: readonly A12PageSample[];
}

const digestValid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string =>
  typeof value === 'string' && PlatformUuidSchema.safeParse(value).success;
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const contentEqual = (a: unknown, b: unknown) =>
  JSON.stringify(canonicalLoadContent(a)) ===
  JSON.stringify(canonicalLoadContent(b));

class PreflightFailure extends Error {
  constructor(readonly reason: A12PreflightReason) {
    super('A12 input could not be admitted.');
  }
}
function preflight(reason: A12PreflightReason): never {
  throw new PreflightFailure(reason);
}

/** Copy data descriptors without evaluating accessors or retaining caller objects. */
function dataSnapshot(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || ancestors.has(value))
    return preflight('configuration');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    (Array.isArray(value)
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null)
  )
    return preflight('configuration');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (
    Object.values(descriptors).some(
      (descriptor) => !Object.hasOwn(descriptor, 'value'),
    )
  )
    return preflight('configuration');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length: unknown = descriptors['length']?.value;
      if (!integer(length) || keys.length !== length + 1)
        return preflight('configuration');
      const array: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable)
          return preflight('configuration');
        array.push(dataSnapshot(descriptor.value, ancestors));
      }
      return Object.freeze(array);
    }
    if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable))
      return preflight('configuration');
    return Object.freeze(
      Object.fromEntries(
        Object.entries(descriptors).map(([key, descriptor]) => [
          key,
          dataSnapshot(descriptor.value, ancestors),
        ]),
      ),
    );
  } finally {
    ancestors.delete(value);
  }
}
function freezeData<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

/** Functions are held ports, never data supplied by a receipt. */
function methodRecord(value: unknown): Record<string, unknown> {
  if (!record(value)) return preflight('configuration');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    return preflight('configuration');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable,
    )
  )
    return preflight('configuration');
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}
function checkedPorts(value: A12RunnerPorts): A12RunnerPorts {
  const methods = methodRecord(value);
  if (
    !exact(methods, [
      'readArtifact',
      'verifyStandardIntake',
      'authenticate',
      'createTransport',
      'now',
      'fingerprint',
    ]) ||
    Object.values(methods).some((fn) => typeof fn !== 'function')
  )
    return preflight('configuration');
  // Capture each callback once, before any await. The caller's getters are never read.
  const captured = methods as unknown as A12RunnerPorts;
  return Object.freeze({
    readArtifact: captured.readArtifact.bind(value),
    verifyStandardIntake: captured.verifyStandardIntake.bind(value),
    authenticate: captured.authenticate.bind(value),
    createTransport: captured.createTransport.bind(value),
    now: captured.now.bind(value),
    fingerprint: captured.fingerprint.bind(value),
  });
}
function checkedPin(value: unknown): boolean {
  return (
    record(value) &&
    exact(value, ['path', 'sha256']) &&
    typeof value['path'] === 'string' &&
    value['path'].length > 0 &&
    [...value['path']].every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value['path']) &&
    digestValid(value['sha256'])
  );
}
function checkedInput(value: unknown): A12RunInput {
  const input = dataSnapshot(value);
  if (
    !record(input) ||
    !exact(input, ['registrationId', 'scope', 'tracks']) ||
    input['registrationId'] !== 'GOAL101-A12-20261004'
  )
    return preflight('configuration');
  const scope = input['scope'];
  if (
    !record(scope) ||
    !exact(scope, ['tenantId', 'projectId', 'purpose']) ||
    !id(scope['tenantId']) ||
    !id(scope['projectId']) ||
    !PlatformPurposeSchema.safeParse(scope['purpose']).success
  )
    return preflight('configuration');
  const tracks = input['tracks'];
  if (!Array.isArray(tracks) || tracks.length !== 2)
    return preflight('configuration');
  for (const [index, track] of tracks.entries()) {
    if (
      !record(track) ||
      !exact(track, ['dataset', 'declared', 'sampleMembers', 'members']) ||
      track['dataset'] !==
        (index === 0 ? 'AUTHENTICATED-REAL' : 'SYNTHETIC-S10')
    )
      return preflight('configuration');
    const declared = track['declared'],
      members = track['members'],
      sampleMembers = track['sampleMembers'];
    if (
      !record(declared) ||
      !exact(declared, ['members', 'assets', 'records', 'geometry'])
    )
      return preflight('configuration');
    if (
      Object.values(declared).some((count) => !integer(count)) ||
      declared['members'] === 0 ||
      declared['assets'] === 0 ||
      !Array.isArray(members) ||
      members.length !== declared['members']
    )
      return preflight('incomplete_inventory');
    if (
      !record(sampleMembers) ||
      !exact(sampleMembers, ['get', 'records', 'geometry']) ||
      Object.values(sampleMembers).some(
        (ordinal) =>
          !integer(ordinal) || ordinal < 1 || ordinal > members.length,
      )
    )
      return preflight('configuration');
    for (const member of members as unknown[]) {
      if (
        !record(member) ||
        !exact(
          member,
          Object.hasOwn(member, 'sourceManifest')
            ? [
                'receipt',
                'inventory',
                'standardCapture',
                'preparedAssets',
                'sourceManifest',
              ]
            : ['receipt', 'inventory', 'standardCapture', 'preparedAssets'],
        ) ||
        !checkedPin(member['receipt']) ||
        !checkedPin(member['inventory']) ||
        !checkedPin(member['standardCapture']) ||
        (Object.hasOwn(member, 'sourceManifest') &&
          !checkedPin(member['sourceManifest']))
      )
        return preflight('configuration');
      const prepared = member['preparedAssets'];
      if (!Array.isArray(prepared) || prepared.length === 0)
        return preflight('incomplete_inventory');
      const ids = new Set<string>();
      for (const asset of prepared as unknown[]) {
        if (
          !record(asset) ||
          !exact(asset, ['assetId', 'artifact', 'sizeBytes']) ||
          !id(asset['assetId']) ||
          !checkedPin(asset['artifact']) ||
          !integer(asset['sizeBytes']) ||
          asset['sizeBytes'] < 1
        )
          return preflight('configuration');
        const identity = asset['assetId'].toLowerCase();
        if (ids.has(identity)) return preflight('incomplete_inventory');
        ids.add(identity);
      }
    }
  }
  // Every nested field and optional pin was checked; snapshot has no caller aliases.
  return input as unknown as A12RunInput;
}
async function artifactBytes(
  pin: A12ArtifactPin,
  ports: A12RunnerPorts,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    const actual = await ports.readArtifact(pin);
    if (!(actual instanceof Uint8Array))
      return preflight('artifact_read_failed');
    bytes = Uint8Array.from(actual);
  } catch {
    return preflight('artifact_read_failed');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256)
    return preflight('artifact_hash_mismatch');
  return bytes;
}
function artifactJson(bytes: Uint8Array, reason: A12PreflightReason): unknown {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    return parsed;
  } catch {
    return preflight(reason);
  }
}
function publicReceipt(value: unknown) {
  try {
    if (
      !record(value) ||
      !exact(value, [
        'createUpload',
        'completeUpload',
        'createIngestion',
        'getIngestion',
        'operation',
        'events',
      ])
    )
      return preflight('receipt_link_mismatch');
    for (const key of ['createUpload', 'completeUpload', 'createIngestion']) {
      if (!record(value[key]) || !exact(value[key], ['input', 'output']))
        return preflight('receipt_link_mismatch');
    }
    const createUpload = value['createUpload'] as Record<string, unknown>;
    const completeUpload = value['completeUpload'] as Record<string, unknown>;
    const createIngestion = value['createIngestion'] as Record<string, unknown>;
    return freezeData({
      createUpload: {
        input: CreateUploadSessionInputSchema.parse(createUpload['input']),
        output: CreateUploadSessionOutputSchema.parse(createUpload['output']),
      },
      completeUpload: {
        input: CompleteUploadSessionInputSchema.parse(completeUpload['input']),
        output: CompleteUploadSessionOutputSchema.parse(
          completeUpload['output'],
        ),
      },
      createIngestion: {
        input: CreateIngestionInputSchema.parse(createIngestion['input']),
        output: CreateIngestionOutputSchema.parse(createIngestion['output']),
      },
      getIngestion: GetIngestionOutputSchema.parse(value['getIngestion']),
      operation: OperationSchema.parse(value['operation']),
      events: OperationEventPageSchema.parse(value['events']),
    });
  } catch {
    return preflight('receipt_link_mismatch');
  }
}
function sameAssetSet(
  ids: readonly string[],
  expected: readonly string[],
): boolean {
  const normalized = ids.map((value) => value.toLowerCase());
  const set = new Set(normalized);
  return (
    normalized.length === set.size &&
    normalized.length === expected.length &&
    expected.every((value) => set.has(value.toLowerCase()))
  );
}
function receiptLinks(
  receipt: ReturnType<typeof publicReceipt>,
  scope: A12RunInput['scope'],
  inventory: FrozenCandidateDataset,
  prepared: A12StandardIntakeCheck['prepared'],
): void {
  const initial = receipt.createUpload.output.uploadSession;
  const complete = receipt.completeUpload.output.uploadSession;
  const ingestion = receipt.getIngestion.ingestion;
  const operation = receipt.operation;
  const created = receipt.createIngestion.output;
  const assets = prepared.map((asset) => asset.assetId);
  const scopeMatches = (item: { tenantId: string; projectId: string }) =>
    sameId(item.tenantId, scope.tenantId) &&
    sameId(item.projectId, scope.projectId);
  if (
    !scopeMatches(initial) ||
    !scopeMatches(complete) ||
    !scopeMatches(ingestion) ||
    !scopeMatches(operation) ||
    !scopeMatches(created.operation) ||
    !sameId(receipt.createUpload.input.ownerProjectId, scope.projectId) ||
    !sameId(receipt.createIngestion.input.ownerProjectId, scope.projectId) ||
    !sameId(initial.uploadSessionId, complete.uploadSessionId) ||
    !sameId(
      initial.uploadSessionId,
      receipt.completeUpload.input.uploadSessionId,
    ) ||
    complete.status !== 'COMPLETED' ||
    receipt.completeUpload.input.expectedVersion < initial.version ||
    complete.version < receipt.completeUpload.input.expectedVersion ||
    !sameId(created.ingestionId, ingestion.ingestionId) ||
    !sameId(created.ingestionId, inventory.batch.reference.ingestionId) ||
    ingestion.operationId === undefined ||
    !sameId(ingestion.operationId, operation.operationId) ||
    !sameId(created.operation.operationId, operation.operationId) ||
    created.operation.capabilityId !== 'data.ingestion.create' ||
    operation.capabilityId !== 'data.ingestion.create' ||
    operation.resource.toLowerCase() !==
      `operation://${operation.operationId.toLowerCase()}` ||
    created.operation.resource.toLowerCase() !==
      operation.resource.toLowerCase() ||
    operation.version < created.operation.version ||
    receipt.getIngestion.candidateReference === null ||
    candidateSavedReferenceKey(receipt.getIngestion.candidateReference) !==
      candidateSavedReferenceKey(inventory.batch.reference)
  )
    return preflight('receipt_link_mismatch');
  const linked = [
    initial.assetIds,
    complete.assetIds,
    receipt.createUpload.output.uploadTargets.map((target) => target.assetId),
    receipt.completeUpload.input.objects.map((object) => object.assetId),
    receipt.createIngestion.input.assetIds,
    ingestion.assetIds,
    inventory.batch.assets.map((asset) => asset.assetId),
  ];
  if (
    linked.some((ids) => !sameAssetSet(ids, assets)) ||
    receipt.createUpload.input.objects.length !== prepared.length ||
    !contentEqual(
      receipt.createIngestion.input.intendedUses,
      ingestion.intendedUses,
    ) ||
    receipt.createIngestion.input.requestedSecurityLevel !==
      ingestion.requestedSecurityLevel ||
    !contentEqual(
      receipt.createIngestion.input.sourceRegistration ?? null,
      ingestion.sourceRegistration ?? null,
    )
  )
    return preflight('receipt_link_mismatch');
  const unused = [...prepared];
  for (const object of receipt.createUpload.input.objects) {
    const index = unused.findIndex(
      (asset) =>
        asset.sizeBytes === object.sizeBytes &&
        (object.sha256 === undefined || asset.sha256 === object.sha256),
    );
    if (index === -1) return preflight('receipt_link_mismatch');
    unused.splice(index, 1);
  }
  for (const asset of prepared) {
    const completed = receipt.completeUpload.input.objects.find((object) =>
      sameId(object.assetId, asset.assetId),
    );
    const candidate = inventory.batch.assets.find((item) =>
      sameId(item.assetId, asset.assetId),
    );
    if (
      completed === undefined ||
      completed.sha256 !== asset.sha256 ||
      completed.sizeBytes !== asset.sizeBytes ||
      candidate === undefined ||
      candidate.sourceHash !== asset.sha256
    )
      return preflight('receipt_link_mismatch');
  }
  let sequence = 0;
  const eventIds = new Set<string>();
  for (const event of receipt.events.items) {
    if (
      !sameId(event.operationId, operation.operationId) ||
      event.sequence <= sequence ||
      event.operationVersion > operation.version ||
      eventIds.has(event.eventId.toLowerCase())
    )
      return preflight('receipt_link_mismatch');
    sequence = event.sequence;
    eventIds.add(event.eventId.toLowerCase());
  }
}
async function manifestLinks(
  member: A12MemberPin,
  receipt: ReturnType<typeof publicReceipt>,
  prepared: A12StandardIntakeCheck['prepared'],
  ports: A12RunnerPorts,
): Promise<void> {
  const registration = receipt.createIngestion.input.sourceRegistration;
  if (registration === undefined) {
    if (member.sourceManifest !== undefined)
      return preflight('receipt_link_mismatch');
    return;
  }
  if (
    member.sourceManifest === undefined ||
    member.sourceManifest.sha256 !== registration.manifestSha256
  )
    return preflight('receipt_link_mismatch');
  const bytes = await artifactBytes(member.sourceManifest, ports);
  let manifest: ReturnType<typeof SourceRegistrationManifestSchema.parse>;
  try {
    manifest = SourceRegistrationManifestSchema.parse(
      artifactJson(bytes, 'receipt_link_mismatch'),
    );
  } catch {
    return preflight('receipt_link_mismatch');
  }
  const manifestAsset = prepared.find((asset) =>
    sameId(asset.assetId, registration.manifestAssetId),
  );
  if (
    manifest.sourceId !== registration.sourceId ||
    manifestAsset === undefined ||
    manifestAsset.sha256 !== registration.manifestSha256 ||
    manifestAsset.sizeBytes !== bytes.length
  )
    return preflight('receipt_link_mismatch');
  for (const file of manifest.files) {
    const linked = prepared.find(
      (asset) =>
        !sameId(asset.assetId, registration.manifestAssetId) &&
        (file.assetId === undefined || sameId(file.assetId, asset.assetId)) &&
        asset.sha256 === file.preparedSha256 &&
        asset.sizeBytes === file.preparedSizeBytes,
    );
    if (
      linked === undefined ||
      (file.disposition === 'IMPORT' &&
        (file.sha256 !== file.preparedSha256 ||
          file.sizeBytes !== file.preparedSizeBytes))
    )
      return preflight('receipt_link_mismatch');
  }
}
async function admitChecked(
  input: A12RunInput,
  ports: A12RunnerPorts,
): Promise<A12AdmittedRun> {
  const tracks: {
    dataset: LoadDataset;
    sampleMembers: A12TrackPin['sampleMembers'];
    members: FrozenCandidateDataset[];
  }[] = [];
  for (const track of input.tracks) {
    const members: FrozenCandidateDataset[] = [];
    const references = new Set<string>();
    let assets = 0,
      records = 0,
      geometry = 0;
    for (const member of track.members) {
      const receipt = publicReceipt(
        artifactJson(
          await artifactBytes(member.receipt, ports),
          'receipt_link_mismatch',
        ),
      );
      const inventory = artifactJson(
        await artifactBytes(member.inventory, ports),
        'incomplete_inventory',
      );
      if (
        !record(inventory) ||
        !exact(inventory, ['batch', 'materials', 'firstPages'])
      )
        return preflight('incomplete_inventory');
      const frozen = readFrozenCandidateInput({
        dataset: track.dataset,
        provenance: {
          kind: 'standard-intake-http',
          receiptSha256: member.receipt.sha256,
          inventorySha256: member.inventory.sha256,
        },
        ...inventory,
      });
      if (frozen.status !== 'ready') return preflight('incomplete_inventory');
      freezeData(frozen.input);
      const reference = candidateSavedReferenceKey(
        frozen.input.batch.reference,
      );
      if (references.has(reference)) return preflight('incomplete_inventory');
      references.add(reference);
      const captureBytes = await artifactBytes(member.standardCapture, ports);
      const prepared: { assetId: string; sha256: string; sizeBytes: number }[] =
        [];
      for (const asset of member.preparedAssets) {
        const bytes = await artifactBytes(asset.artifact, ports);
        if (bytes.length !== asset.sizeBytes)
          return preflight('receipt_link_mismatch');
        prepared.push({
          assetId: asset.assetId,
          sha256: asset.artifact.sha256,
          sizeBytes: bytes.length,
        });
      }
      receiptLinks(receipt, input.scope, frozen.input, prepared);
      await manifestLinks(member, receipt, prepared, ports);
      let verified: unknown;
      try {
        verified = await ports.verifyStandardIntake(
          Object.freeze({
            receipt,
            captureBytes,
            prepared: freezeData(prepared),
            inventory: frozen.input,
          }),
        );
      } catch {
        return preflight('standard_intake_unverified');
      }
      if (verified !== 'verified')
        return preflight('standard_intake_unverified');
      for (const asset of frozen.input.batch.assets) {
        if (asset.recordCount === null || asset.featureCount === null)
          return preflight('incomplete_inventory');
        assets += 1;
        records += asset.recordCount;
        geometry += asset.featureCount;
      }
      members.push(frozen.input);
    }
    if (
      !Number.isSafeInteger(records) ||
      !Number.isSafeInteger(geometry) ||
      members.length !== track.declared.members ||
      assets !== track.declared.assets ||
      records !== track.declared.records ||
      geometry !== track.declared.geometry
    )
      return preflight('incomplete_inventory');
    tracks.push({
      dataset: track.dataset,
      sampleMembers: track.sampleMembers,
      members,
    });
  }
  return freezeData({ scope: input.scope, tracks });
}

/** Actual bytes and public associations are admitted before any authentication. */
export async function admitA12RunInput(
  value: unknown,
  ports: A12RunnerPorts,
): Promise<A12Admission> {
  try {
    const checked = checkedPorts(ports);
    return {
      status: 'ready',
      input: await admitChecked(checkedInput(value), checked),
    };
  } catch (error) {
    return {
      status: 'not_run',
      reason:
        error instanceof PreflightFailure ? error.reason : 'configuration',
    };
  }
}

const failures: readonly LoadFailure[] = [
  'denied',
  'stale',
  'invalid',
  'unavailable',
  'cancelled',
  'drift',
  'instrumentation',
];
function failureKind(error: unknown): LoadFailure {
  if (error instanceof CandidateLoadTransportError) {
    const kind: unknown = Object.getOwnPropertyDescriptor(error, 'kind')?.value;
    if (failures.some((failure) => kind === failure))
      return kind as LoadFailure;
  }
  if (error instanceof CandidateLoadAuthError) {
    const kind: unknown = Object.getOwnPropertyDescriptor(error, 'kind')?.value;
    if (kind === 'authentication' || kind === 'denied') return 'denied';
    if (kind === 'changed') return 'stale';
    if (kind === 'closed') return 'cancelled';
    if (kind === 'invalid' || kind === 'configuration') return 'invalid';
  }
  return 'unavailable';
}
function releaseRejectedHandle(value: unknown): void {
  try {
    if (!record(value)) return;
    const close = Object.getOwnPropertyDescriptor(value, 'close');
    if (
      close !== undefined &&
      Object.hasOwn(close, 'value') &&
      typeof close.value === 'function'
    )
      (close.value as () => void).call(value);
  } catch {
    // The owned factory result was already rejected. Preserve that first
    // failure, and never evaluate a close getter or persist its raw error.
  }
}
function checkedGuard(value: CandidateLoadAuthGuard): CandidateLoadAuthGuard {
  try {
    const methods = methodRecord(value);
    if (
      !exact(methods, ['verifyCondition', 'close']) ||
      typeof methods['verifyCondition'] !== 'function' ||
      typeof methods['close'] !== 'function'
    )
      throw new CandidateLoadTransportError('invalid');
    const held = methods as unknown as CandidateLoadAuthGuard;
    return {
      verifyCondition: held.verifyCondition.bind(value),
      close: held.close.bind(value),
    };
  } catch (error) {
    releaseRejectedHandle(value);
    throw error;
  }
}
function checkedCondition(
  value: CandidateLoadAuthCondition,
): CandidateLoadAuthCondition {
  const methods = methodRecord(value);
  if (
    !exact(methods, ['accessToken', 'summary']) ||
    typeof methods['accessToken'] !== 'function'
  )
    throw new CandidateLoadTransportError('invalid');
  const summary = dataSnapshot(methods['summary']);
  if (
    !record(summary) ||
    !exact(summary, [
      'identityDigest',
      'authorityDigest',
      'claimsVerified',
      'sessionTokenMatched',
      'identityMatched',
      'necessaryCandidateScopes',
      'maintainerScope',
      'reviewerScope',
      'candidateAuthority',
    ]) ||
    !digestValid(summary['identityDigest']) ||
    !digestValid(summary['authorityDigest']) ||
    summary['claimsVerified'] !== true ||
    summary['sessionTokenMatched'] !== true ||
    summary['identityMatched'] !== true ||
    summary['necessaryCandidateScopes'] !== true ||
    typeof summary['maintainerScope'] !== 'boolean' ||
    typeof summary['reviewerScope'] !== 'boolean' ||
    summary['candidateAuthority'] !== 'requires-current-candidate-get'
  )
    throw new CandidateLoadTransportError('invalid');
  return Object.freeze({
    accessToken: (
      methods['accessToken'] as CandidateLoadAuthCondition['accessToken']
    ).bind(value),
    summary: summary as unknown as CandidateLoadAuthCondition['summary'],
  });
}
function checkedAdapter(
  value: CandidateLoadHttpAdapter,
): CandidateLoadHttpAdapter {
  try {
    const methods = methodRecord(value);
    if (
      !exact(methods, ['send', 'close', 'diagnostics']) ||
      Object.values(methods).some((method) => typeof method !== 'function')
    )
      throw new CandidateLoadTransportError('invalid');
    const held = methods as unknown as CandidateLoadHttpAdapter;
    return {
      send: held.send.bind(value),
      close: held.close.bind(value),
      diagnostics: held.diagnostics.bind(value),
    };
  } catch (error) {
    releaseRejectedHandle(value);
    throw error;
  }
}
function closeAdapter(adapter: CandidateLoadHttpAdapter): void {
  adapter.close();
  const counts = methodRecord(adapter.diagnostics());
  if (
    !exact(counts, ['activeRequests', 'closed']) ||
    counts['activeRequests'] !== 0 ||
    counts['closed'] !== true
  )
    throw new CandidateLoadTransportError('instrumentation');
}
function finishAdapter(
  adapter: CandidateLoadHttpAdapter,
  alreadyFailed: boolean,
): void {
  if (!alreadyFailed) return closeAdapter(adapter);
  try {
    closeAdapter(adapter);
  } catch {
    // A cleanup exception cannot replace the first sampling/authority failure.
  }
}
function measurementPorts(
  ports: A12RunnerPorts,
): Pick<LoadPorts, 'now' | 'fingerprint'> {
  let previous = -Infinity;
  return {
    now: () => {
      let time: number;
      try {
        time = ports.now();
      } catch {
        throw new CandidateLoadTransportError('instrumentation');
      }
      if (!Number.isFinite(time) || time < previous)
        throw new CandidateLoadTransportError('instrumentation');
      previous = time;
      return time;
    },
    fingerprint: (value) => {
      let digest: string;
      try {
        digest = ports.fingerprint(value);
      } catch {
        throw new CandidateLoadTransportError('instrumentation');
      }
      if (!digestValid(digest))
        throw new CandidateLoadTransportError('instrumentation');
      return digest;
    },
  };
}
class RunStopped extends Error {
  constructor(readonly reason: A12RunResult['reason']) {
    super('A12 candidate run stopped.');
  }
}

/** Fixed real helper orchestration; this component never certifies all of A12. */
export async function runA12CandidateMatrix(
  value: unknown,
  ports: A12RunnerPorts,
): Promise<A12RunResult> {
  const conditions: A12RunResult['conditions'][number][] = [];
  const rounds: A12RunResult['rounds'][number][] = [];
  const pageSamples: A12PageSample[] = [];
  const result = (
    status: A12RunResult['status'],
    reason: A12RunResult['reason'],
  ): A12RunResult =>
    freezeData({
      registrationId: 'GOAL101-A12-20261004',
      status,
      reason,
      formalA12: 'not_run',
      conditions,
      rounds,
      pageSamples,
    });
  let checked: A12RunnerPorts, admitted: A12AdmittedRun;
  try {
    checked = checkedPorts(ports);
    admitted = await admitChecked(checkedInput(value), checked);
  } catch (error) {
    return result(
      'not_run',
      error instanceof PreflightFailure ? error.reason : 'configuration',
    );
  }
  const clock = measurementPorts(checked);
  let guard: CandidateLoadAuthGuard | null = null;
  let started = false;
  let status: A12RunResult['status'] = 'passed';
  let reason: A12RunResult['reason'] = null;
  try {
    guard = checkedGuard(await checked.authenticate(admitted.scope));
    for (const [trackIndex, track] of admitted.tracks.entries()) {
      const trackOrdinal = trackIndex + 1;
      for (const [conditionIndex, condition] of candidateLoadConditions(
        track.dataset,
      ).entries()) {
        const memberOrdinal = track.sampleMembers[condition.action];
        const member = track.members[memberOrdinal - 1];
        if (member === undefined) throw new RunStopped('incomplete_inventory');
        const authorized = checkedCondition(await guard.verifyCondition());
        const adapter = checkedAdapter(
          checked.createTransport(
            authorized,
            Object.freeze({
              phase: 'condition',
              trackOrdinal,
              memberOrdinal,
              conditionOrdinal: conditionIndex + 1,
              roundOrdinal: null,
            }),
          ),
        );
        let attemptFailed = false;
        try {
          started = true;
          const measured = await runCandidateLoadCondition(member, condition, {
            ...clock,
            send: adapter.send,
          });
          conditions.push({
            trackOrdinal,
            memberOrdinal,
            ordinal: conditionIndex + 1,
            result: measured,
          });
          if (measured.status !== 'passed') {
            const failed = [...measured.warmup, ...measured.measured].find(
              (sample) => sample.outcome !== 'completed',
            );
            throw new RunStopped(
              measured.status === 'not_run'
                ? 'incomplete_inventory'
                : failed?.outcome === 'completed'
                  ? null
                  : (failed?.outcome ?? null),
            );
          }
        } catch (error) {
          attemptFailed = true;
          throw error;
        } finally {
          finishAdapter(adapter, attemptFailed);
        }
      }
      for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
        const members: { memberOrdinal: number; result: TraversalIteration }[] =
          [];
        rounds.push({ trackOrdinal, ordinal, members });
        for (const [memberIndex, member] of track.members.entries()) {
          const memberOrdinal = memberIndex + 1;
          const authorized = checkedCondition(await guard.verifyCondition());
          const adapter = checkedAdapter(
            checked.createTransport(
              authorized,
              Object.freeze({
                phase: 'traversal',
                trackOrdinal,
                memberOrdinal,
                conditionOrdinal: null,
                roundOrdinal: ordinal,
              }),
            ),
          );
          let pageOrdinal = 0;
          const send: LoadPorts['send'] = async (request) => {
            let began: number | null = null,
              elapsedMs: number | null = null,
              wireBytes: number | null = null;
            let outcome: A12PageSample['outcome'] = 'unavailable';
            let reply: Awaited<ReturnType<LoadPorts['send']>> | null = null;
            try {
              began = clock.now();
              reply = await adapter.send(request);
              wireBytes =
                Number.isSafeInteger(reply.wireBytes) && reply.wireBytes >= 0
                  ? reply.wireBytes
                  : null;
              // Includes the raw adapter's UTF8/JSON parse and actual public DTO validation.
              const validated = validateLoadReply(member, request, reply);
              outcome = validated.ok ? 'completed' : validated.failure;
            } catch (error) {
              outcome = failureKind(error);
            }
            try {
              const ended = clock.now();
              if (began !== null && ended >= began) elapsedMs = ended - began;
              else outcome = 'instrumentation';
            } catch {
              outcome = 'instrumentation';
            }
            pageSamples.push({
              trackOrdinal,
              roundOrdinal: ordinal,
              memberOrdinal,
              pageOrdinal: ++pageOrdinal,
              action: request.action,
              elapsedMs,
              outcome,
              wireBytes,
            });
            if (outcome !== 'completed' || reply === null)
              throw new CandidateLoadTransportError(
                outcome === 'completed' ? 'unavailable' : outcome,
              );
            // Final ordered-chain/count mismatch remains the iteration's drift; it
            // does not relabel a correctly transported/validated last page.
            return reply;
          };
          let attemptFailed = false;
          try {
            started = true;
            const traversal = await runCandidateLoadTraversalOnce(
              member,
              { ...clock, send },
              ordinal,
            );
            if (traversal.iteration === null)
              throw new RunStopped('incomplete_inventory');
            members.push({ memberOrdinal, result: traversal.iteration });
            if (traversal.status !== 'passed')
              throw new RunStopped(
                traversal.iteration.outcome === 'completed'
                  ? null
                  : traversal.iteration.outcome,
              );
          } catch (error) {
            attemptFailed = true;
            throw error;
          } finally {
            finishAdapter(adapter, attemptFailed);
          }
        }
      }
    }
  } catch (error) {
    status = started ? 'failed' : 'not_run';
    reason =
      error instanceof RunStopped
        ? error.reason
        : error instanceof PreflightFailure
          ? error.reason
          : failureKind(error);
  } finally {
    if (guard !== null) {
      try {
        guard.close();
      } catch (error) {
        if (status === 'passed') {
          status = started ? 'failed' : 'not_run';
          reason = failureKind(error);
        }
      }
    }
  }
  return result(status, reason);
}

import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type GateStatus = 'pending' | 'confirmed' | 'blocked';
export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  dependency: string;
  status: GateStatus;
  version: string;
  delivered: boolean;
}
export interface Blocker {
  id: string;
  title: string;
  severity: 'warning' | 'critical';
  resolved: boolean;
  repository?: string;
}
export interface FreezeEntry {
  gateId: string;
  repository: string;
  version: string;
  delivered: boolean;
  referenced: boolean;
  at: string;
}
export type ChangeStepAction = 'set-version' | 'invalidate-confirmation' | 'queue-next-batch';
export interface ChangeStep {
  id: string;
  gateId: string;
  repository: string;
  action: ChangeStepAction;
  status: 'pending' | 'done' | 'failed';
  note: string;
}
export type ChangeStatus = 'pending' | 'done' | 'failed' | 'conflict';
export interface ChangeRequest {
  id: string;
  gateId: string;
  repository: string;
  fromVersion: string;
  toVersion: string;
  kind: 'swap' | 'next-batch';
  status: ChangeStatus;
  reason: string;
  steps: ChangeStep[];
  createdAt: string;
}
export interface NextBatchItem {
  id: string;
  gateId: string;
  repository: string;
  version: string;
  changeId: string;
  at: string;
}
export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: 'preparing' | 'frozen' | 'rolled-back';
  gates: RepositoryGate[];
  blockers: Blocker[];
  freezeRecord: FreezeEntry[];
  changes: ChangeRequest[];
  nextBatch: NextBatchItem[];
  audit: Array<{ id: string; at: string; text: string }>;
}

interface TrainState {
  activeId: string;
  trains: ReleaseTrain[];
}

const initial: TrainState = {
  activeId: 'train-101',
  trains: [{
    id: 'train-101',
    name: 'Sept 2026 发布列车',
    freezeAt: '2026-09-30 18:00',
    status: 'preparing',
    gates: [
      { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0', delivered: true },
      { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0', delivered: false },
      { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'blocked', version: '1.9.4', delivered: false }
    ],
    blockers: [
      { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false, repository: 'data-sync' },
      { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
    ],
    freezeRecord: [],
    changes: [],
    nextBatch: [],
    audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 3 个仓库' }]
  }]
};

let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now()}-${(seq += 1)}`;
const now = () => new Date().toLocaleTimeString();
const log = (train: ReleaseTrain, text: string) => {
  train.audit.unshift({ id: uid('a'), at: now(), text });
};
const dependentsOf = (train: ReleaseTrain, repository: string) =>
  train.gates.filter((gate) => gate.dependency.startsWith(`${repository}@`));
const hasCriticalBlocker = (train: ReleaseTrain, repository: string) =>
  train.blockers.some((item) => !item.resolved && item.severity === 'critical' && item.repository === repository);

const trainSlice = createSlice({
  name: 'train',
  initialState: initial,
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = `train-${Date.now()}`;
      state.trains.push({
        id,
        ...action.payload,
        status: 'preparing',
        gates: [],
        blockers: [],
        freezeRecord: [],
        changes: [],
        nextBatch: [],
        audit: [{ id: uid('a'), at: now(), text: '创建发布列车' }]
      });
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) { state.activeId = action.payload; },
    confirmGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      gate.status = 'confirmed';
      log(train, `${gate.repository} 门禁由发布负责人确认`);
    },
    setFreeze(state, action: PayloadAction<'preparing' | 'frozen'>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      train.status = action.payload;
      if (action.payload === 'frozen') {
        const at = new Date().toLocaleString();
        train.freezeRecord = train.gates.map((gate) => ({
          gateId: gate.id,
          repository: gate.repository,
          version: gate.version,
          delivered: gate.delivered,
          referenced: dependentsOf(train, gate.repository).length > 0,
          at
        }));
        log(train, `冻结列车，记录 ${train.gates.length} 个仓库的版本与交付快照`);
      } else {
        log(train, `状态调整为 ${action.payload}`);
      }
    },
    toggleDelivered(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      gate.delivered = !gate.delivered;
      const entry = train.freezeRecord.find((item) => item.gateId === gate.id);
      if (entry) entry.delivered = gate.delivered;
      log(train, `${gate.repository} ${gate.delivered ? '标记为已交付' : '标记为未交付'}`);
    },
    requestChange(state, action: PayloadAction<{ gateId: string; toVersion: string; reason: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload.gateId);
      if (!train || !gate || train.status !== 'frozen') return;
      const { toVersion, reason } = action.payload;
      const inflight = train.changes.some((item) => item.gateId === gate.id && (item.status === 'pending' || item.status === 'failed'));
      if (inflight) {
        train.changes.unshift({
          id: uid('chg'), gateId: gate.id, repository: gate.repository,
          fromVersion: gate.version, toVersion, kind: 'swap', status: 'conflict',
          reason, steps: [], createdAt: now()
        });
        log(train, `冲突：${gate.repository} 已有变更在办，驳回 ${gate.version} → ${toVersion} 的申请`);
        return;
      }
      const entry = train.freezeRecord.find((item) => item.gateId === gate.id);
      const kind: ChangeRequest['kind'] = entry?.delivered && entry.referenced ? 'next-batch' : 'swap';
      const steps: ChangeStep[] = [];
      if (kind === 'swap') {
        steps.push({ id: uid('st'), gateId: gate.id, repository: gate.repository, action: 'set-version', status: 'pending', note: `版本 ${gate.version} → ${toVersion}` });
        for (const dependent of dependentsOf(train, gate.repository)) {
          steps.push({
            id: uid('st'), gateId: dependent.id, repository: dependent.repository,
            action: 'invalidate-confirmation', status: 'pending',
            note: `依赖 ${dependent.dependency} 受 ${gate.repository}@${toVersion} 影响，确认失效需重新确认`
          });
        }
      } else {
        steps.push({
          id: uid('st'), gateId: gate.id, repository: gate.repository,
          action: 'queue-next-batch', status: 'pending',
          note: `已交付且被下游引用，不退回旧版本，补录 ${toVersion} 排进下一批`
        });
      }
      train.changes.unshift({
        id: uid('chg'), gateId: gate.id, repository: gate.repository,
        fromVersion: gate.version, toVersion, kind, status: 'pending',
        reason, steps, createdAt: now()
      });
      log(train, `受理 ${gate.repository} 版本变更 ${gate.version} → ${toVersion}（${kind === 'swap' ? '直接换版' : '补入下一批'}）`);
    },
    processChange(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const change = train?.changes.find((item) => item.id === action.payload);
      if (!train || !change || change.status === 'done' || change.status === 'conflict') return;
      if (change.status === 'failed') log(train, `重试变更单 ${change.id}，跳过已完成仓库`);
      for (const step of change.steps) {
        if (step.status === 'done') continue;
        const gate = train.gates.find((item) => item.id === step.gateId);
        if (!gate || hasCriticalBlocker(train, step.repository)) {
          step.status = 'failed';
          change.status = 'failed';
          log(train, `${step.repository} 处理失败：存在未关闭的严重阻断项，已完成仓库保留`);
          break;
        }
        if (step.action === 'set-version') {
          gate.version = change.toVersion;
          log(train, `${gate.repository} 版本切换为 ${change.toVersion}`);
        } else if (step.action === 'invalidate-confirmation') {
          if (gate.status === 'confirmed') {
            gate.status = 'pending';
            log(train, `${gate.repository} 的确认因 ${change.repository}@${change.toVersion} 变更失效，需重新确认`);
          }
        } else {
          train.nextBatch.push({ id: uid('nb'), gateId: gate.id, repository: gate.repository, version: change.toVersion, changeId: change.id, at: now() });
          log(train, `${gate.repository} 补录 ${change.toVersion} 排进下一批`);
        }
        step.status = 'done';
      }
      if (change.steps.every((step) => step.status === 'done')) {
        change.status = 'done';
        log(train, `变更单 ${change.id} 全部完成`);
      }
    },
    resolveBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker) return;
      blocker.resolved = true;
      log(train, `阻断项已关闭：${blocker.title}`);
    },
    reorderGates(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const from = train.gates.findIndex((item) => item.id === action.payload.activeId);
      const to = train.gates.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = train.gates.splice(from, 1);
      train.gates.splice(to, 0, moved);
      log(train, `调整 ${moved.repository} 的发布顺序`);
    },
    replaceState(_state, action: PayloadAction<TrainState>) {
      return {
        ...action.payload,
        trains: action.payload.trains.map((train) => ({
          ...train,
          gates: train.gates.map((gate) => ({ ...gate, delivered: gate.delivered ?? false })),
          blockers: train.blockers ?? [],
          freezeRecord: train.freezeRecord ?? [],
          changes: train.changes ?? [],
          nextBatch: train.nextBatch ?? []
        }))
      };
    }
  }
});

export const releaseApi = createApi({
  reducerPath: 'releaseApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getTrainHealth: builder.query<{ ready: boolean; checkedAt: string }, string>({
      queryFn: (id) => ({ data: { ready: id !== 'offline', checkedAt: new Date().toISOString() } })
    })
  })
});

export const { useGetTrainHealthQuery } = releaseApi;
export const {
  activateTrain, confirmGate, createTrain, processChange, reorderGates,
  requestChange, replaceState, resolveBlocker, setFreeze, toggleDelivered
} = trainSlice.actions;

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf53-release-state');
  if (saved) store.dispatch(replaceState(JSON.parse(saved) as TrainState));
  store.subscribe(() => localStorage.setItem('yf53-release-state', JSON.stringify(store.getState().train)));
}

export type RootState = ReturnType<typeof store.getState>;

import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type GateStatus = 'pending' | 'confirmed' | 'blocked';
export type DeliveryStatus = 'pending' | 'delivered';
export type ChangeStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'conflict';

export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  dependency: string;
  status: GateStatus;
  version: string;
  delivery: DeliveryStatus;
  batch: string;
}

export interface FreezeGateSnapshot {
  gateId: string;
  repository: string;
  version: string;
  delivery: DeliveryStatus;
  referencedBy: string[];
}

export interface FreezeSnapshot {
  frozenAt: string;
  gates: FreezeGateSnapshot[];
}

export interface ChangeRequest {
  id: string;
  repository: string;
  fromVersion: string;
  toVersion: string;
  reason: string;
  status: ChangeStatus;
  attempts: number;
  batch?: string;
  error?: string;
  refId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: 'preparing' | 'frozen' | 'rolled-back';
  gates: RepositoryGate[];
  blockers: Array<{ id: string; title: string; severity: 'warning' | 'critical'; resolved: boolean }>;
  audit: Array<{ id: string; at: string; text: string }>;
  freezeSnapshots: FreezeSnapshot[];
  changeRequests: ChangeRequest[];
}

interface TrainState {
  activeId: string;
  trains: ReleaseTrain[];
}

function nowTime() { return new Date().toLocaleTimeString(); }
function nowStamp() { return new Date().toLocaleString(); }

let idSeq = 0;
function nextId(prefix: string) { return `${prefix}-${Date.now()}-${idSeq++}`; }

/** dependency 字段形如 "gateway@2.12"，取被依赖的仓库名 */
function depName(dep: string) { return dep.split('@')[0].trim(); }

/** 依赖某仓库的下游门禁（同批次内），即版本变化后受牵连的仓库 */
function downstreamOf(gates: RepositoryGate[], repo: string, batch: string): RepositoryGate[] {
  return gates.filter((g) => g.batch === batch && depName(g.dependency) === repo);
}

/** FNV-1a 哈希，雪崩效应好，避免相似字符串取模扎堆 */
function xfnv1a(str: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 确定性的处理失败模拟：同一申请第 n 次尝试失败与否可复现，重试会换结果 */
function shouldFail(req: ChangeRequest) {
  return xfnv1a(`${req.id}:${req.attempts}:${req.repository}`) % 4 === 0;
}

/** 真正执行换版：未交付直接换；已交付且被引用则补新版本排进下一批。返回是否成功 */
function applyChange(train: ReleaseTrain, req: ChangeRequest): boolean {
  const gate = train.gates.find((g) => g.repository === req.repository && g.batch !== '下一批')
    ?? train.gates.find((g) => g.repository === req.repository);
  if (!gate) {
    req.status = 'failed';
    req.error = '仓库门禁不存在，无法换版';
    req.updatedAt = nowTime();
    return false;
  }
  const downstream = downstreamOf(train.gates, gate.repository, gate.batch);
  const referenced = downstream.length > 0;
  const t = nowTime();

  if (gate.delivery === 'delivered' && referenced) {
    // 已交付又被下游引用：不退回旧版本，补一个新版本排进下一批
    train.gates.push({
      id: nextId('g'),
      repository: gate.repository,
      owner: gate.owner,
      dependency: gate.dependency,
      status: 'pending',
      version: req.toVersion,
      delivery: 'pending',
      batch: '下一批'
    });
    req.batch = '下一批';
    train.audit.unshift({
      id: nextId('a'), at: t,
      text: `${gate.repository} 已交付且被 ${downstream.map((d) => d.repository).join('、')} 引用：不回退 ${gate.version}，新版本 ${req.toVersion} 排入下一批`
    });
    return true;
  }

  // 还没交付（或交付后无引用）：直接换版本，受牵连下游确认失效、需重新确认
  const from = gate.version;
  gate.version = req.toVersion;
  let invalidated = 0;
  for (const d of downstream) {
    if (d.status !== 'pending') {
      d.status = 'pending';
      invalidated += 1;
      train.audit.unshift({
        id: nextId('a'), at: t,
        text: `版本牵连：${gate.repository} 已升至 ${req.toVersion}，下游 ${d.repository} 的门禁确认失效，需重新确认`
      });
    }
  }
  train.audit.unshift({
    id: nextId('a'), at: t,
    text: `${gate.repository} 直接换版 ${from} → ${req.toVersion}${invalidated ? `，${invalidated} 个下游仓库确认失效待重新确认` : ''}`
  });
  return true;
}

const initial: TrainState = {
  activeId: 'train-101',
  trains: [{
    id: 'train-101',
    name: 'Sept 2026 发布列车',
    freezeAt: '2026-09-30 18:00',
    status: 'preparing',
    gates: [
      { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0', delivery: 'delivered', batch: '2026-09 批' },
      { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'confirmed', version: '2.12.0', delivery: 'delivered', batch: '2026-09 批' },
      { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'blocked', version: '1.9.4', delivery: 'pending', batch: '2026-09 批' },
      { id: 'g4', repository: 'report-service', owner: '林岚', dependency: 'data-sync@1.9', status: 'confirmed', version: '3.2.1', delivery: 'delivered', batch: '2026-09 批' }
    ],
    blockers: [
      { id: 'b1', title: 'data-sync 依赖的 gateway@2.12 联调未完成', severity: 'critical', resolved: false },
      { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
    ],
    audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 4 个仓库' }],
    freezeSnapshots: [],
    changeRequests: []
  }]
};

const trainSlice = createSlice({
  name: 'train',
  initialState: initial,
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = nextId('train');
      state.trains.push({
        id, ...action.payload, status: 'preparing',
        gates: [], blockers: [],
        audit: [{ id: nextId('a'), at: nowTime(), text: '创建发布列车' }],
        freezeSnapshots: [], changeRequests: []
      });
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) { state.activeId = action.payload; },
    confirmGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      gate.status = 'confirmed';
      train.audit.unshift({ id: nextId('a'), at: nowTime(), text: `${gate.repository} 门禁由发布负责人确认` });
    },
    freezeTrain(state) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      train.status = 'frozen';
      train.freezeSnapshots.unshift({
        frozenAt: nowStamp(),
        gates: train.gates.map((g) => ({
          gateId: g.id,
          repository: g.repository,
          version: g.version,
          delivery: g.delivery,
          referencedBy: downstreamOf(train.gates, g.repository, g.batch).map((d) => d.repository)
        }))
      });
      train.audit.unshift({
        id: nextId('a'), at: nowTime(),
        text: `冻结列车：已记录 ${train.gates.length} 个仓库的版本与交付情况，下游引用关系一并留痕`
      });
    },
    setFreeze(state, action: PayloadAction<ReleaseTrain['status']>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      train.status = action.payload;
      train.audit.unshift({ id: nextId('a'), at: nowTime(), text: `状态调整为 ${action.payload}` });
    },
    requestVersionChange(state, action: PayloadAction<{ repository: string; toVersion: string; reason: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.repository === action.payload.repository && item.batch !== '下一批');
      if (!train || !gate) return;
      const t = nowTime();
      const active = train.changeRequests.find((r) => r.repository === gate.repository && (r.status === 'queued' || r.status === 'processing'));
      if (active) {
        // 同一个仓库已有变更在办：后到的申请记为冲突，不进入处理队列
        train.changeRequests.unshift({
          id: nextId('c'),
          repository: gate.repository,
          fromVersion: gate.version,
          toVersion: action.payload.toVersion,
          reason: action.payload.reason,
          status: 'conflict',
          attempts: 0,
          refId: active.id,
          createdAt: t,
          updatedAt: t
        });
        train.audit.unshift({
          id: nextId('a'), at: t,
          text: `冲突提示：${gate.repository} 已有变更在办（${active.id}），本次申请被拒绝`
        });
        return;
      }
      train.changeRequests.unshift({
        id: nextId('c'),
        repository: gate.repository,
        fromVersion: gate.version,
        toVersion: action.payload.toVersion,
        reason: action.payload.reason,
        status: 'queued',
        attempts: 0,
        createdAt: t,
        updatedAt: t
      });
      train.audit.unshift({
        id: nextId('a'), at: t,
        text: `收到 ${gate.repository} 换版申请 ${gate.version} → ${action.payload.toVersion}，进入处理队列`
      });
    },
    processChangeQueue(state) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      // 队列按申请先后（FIFO）处理：数组头部是最新申请，取反得到最早申请
      const queued = train.changeRequests.filter((r) => r.status === 'queued').reverse();
      if (!queued.length) return;
      for (const req of queued) {
        req.status = 'processing';
        req.attempts += 1;
        if (shouldFail(req)) {
          req.status = 'failed';
          req.error = '远端版本校验超时；已完成的仓库不受影响，可重试未完成的仓库';
          req.updatedAt = nowTime();
          train.audit.unshift({
            id: nextId('a'), at: nowTime(),
            text: `处理失败：${req.repository} 换版未完成（${req.error}），已完成仓库保留`
          });
          continue;
        }
        if (applyChange(train, req)) {
          req.status = 'completed';
          req.updatedAt = nowTime();
        }
      }
    },
    retryFailedChanges(state) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const failed = train.changeRequests.filter((r) => r.status === 'failed');
      if (!failed.length) return;
      for (const req of failed) {
        req.status = 'queued';
        req.error = undefined;
        train.audit.unshift({
          id: nextId('a'), at: nowTime(),
          text: `重试失败项：${req.repository}（第 ${req.attempts + 1} 次尝试）`
        });
      }
      trainSlice.caseReducers.processChangeQueue(state);
    },
    resolveBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker) return;
      blocker.resolved = true;
      train.audit.unshift({ id: nextId('a'), at: nowTime(), text: `阻断项已关闭：${blocker.title}` });
    },
    reorderGates(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const from = train.gates.findIndex((item) => item.id === action.payload.activeId);
      const to = train.gates.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = train.gates.splice(from, 1);
      train.gates.splice(to, 0, moved);
      train.audit.unshift({ id: nextId('a'), at: nowTime(), text: `调整 ${moved.repository} 的发布顺序` });
    },
    replaceState(_state, action: PayloadAction<TrainState>) { return action.payload; }
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

/** 兼容旧 localStorage 数据：补齐交付情况、批次、冻结快照与变更申请 */
function normalizeTrain(raw: ReleaseTrain): ReleaseTrain {
  return {
    ...raw,
    freezeSnapshots: raw.freezeSnapshots ?? [],
    changeRequests: raw.changeRequests ?? [],
    gates: raw.gates.map((g) => ({
      ...g,
      delivery: g.delivery ?? (g.status === 'confirmed' ? 'delivered' : 'pending'),
      batch: g.batch ?? '2026-09 批'
    }))
  };
}

export const { useGetTrainHealthQuery } = releaseApi;
export const {
  activateTrain, confirmGate, createTrain, freezeTrain, setFreeze,
  processChangeQueue, requestVersionChange, resolveBlocker, reorderGates,
  retryFailedChanges, replaceState
} = trainSlice.actions;

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf53-release-state');
  if (saved) {
    const parsed = JSON.parse(saved) as TrainState;
    store.dispatch(replaceState({ activeId: parsed.activeId, trains: parsed.trains.map(normalizeTrain) }));
  }
  store.subscribe(() => localStorage.setItem('yf53-release-state', JSON.stringify(store.getState().train)));
}

export type RootState = ReturnType<typeof store.getState>;

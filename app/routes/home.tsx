import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Badge, Button, Card, Group, Modal, Progress, SimpleGrid, Stack, Text, TextInput, Textarea, Title } from '@mantine/core';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain, confirmGate, createTrain, freezeTrain, processChangeQueue,
  requestVersionChange, resolveBlocker, reorderGates, retryFailedChanges,
  setFreeze, useGetTrainHealthQuery, type ChangeRequest, type RepositoryGate
} from '../store';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

const changeSchema = z.object({
  toVersion: z.string().min(1, '请填写目标版本'),
  reason: z.string().min(2, '请填写变更原因')
});

const changeStatusMeta: Record<ChangeRequest['status'], { label: string; color: string }> = {
  queued: { label: '在办排队', color: 'yellow' },
  processing: { label: '处理中', color: 'blue' },
  completed: { label: '已完成', color: 'green' },
  failed: { label: '失败', color: 'red' },
  conflict: { label: '冲突', color: 'orange' }
};

function SortableGate({ gate, onConfirm, onChangeRequest }: { gate: RepositoryGate; onConfirm: () => void; onChangeRequest: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: gate.id });
  return (
    <Card ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="xs" mb={4}>
            <Text fw={700}>{gate.repository}</Text>
            <Badge size="xs" color={gate.delivery === 'delivered' ? 'teal' : 'gray'}>{gate.delivery === 'delivered' ? '已交付' : '未交付'}</Badge>
            <Badge size="xs" variant="outline">{gate.batch}</Badge>
          </Group>
          <Text size="sm" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency} · 版本 {gate.version}</Text>
        </div>
        <Group>
          <Badge color={gate.status === 'confirmed' ? 'green' : gate.status === 'blocked' ? 'red' : 'yellow'}>{gate.status}</Badge>
          <Button size="xs" variant="light" onClick={onConfirm} disabled={gate.status === 'confirmed'}>确认门禁</Button>
          <Button size="xs" variant="outline" onClick={onChangeRequest}>申请换版</Button>
          <Button size="xs" variant="subtle" {...attributes} {...listeners}>拖拽排序</Button>
        </Group>
      </Group>
    </Card>
  );
}

export default function Home() {
  const dispatch = useDispatch();
  const state = useSelector((root: { train: ReturnType<typeof import('../store').store.getState>['train'] }) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];
  const { data: health } = useGetTrainHealthQuery(train?.id ?? 'offline');
  const sensors = useSensors(useSensor(PointerSensor));
  const [changeFor, setChangeFor] = useState<RepositoryGate | null>(null);
  const [toVersion, setToVersion] = useState('');
  const [reason, setReason] = useState('');
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });

  const unresolved = train?.blockers.filter((item) => !item.resolved).length ?? 0;
  const confirmed = train?.gates.filter((item) => item.status === 'confirmed').length ?? 0;
  const queuedCount = train?.changeRequests.filter((item) => item.status === 'queued').length ?? 0;
  const failedCount = train?.changeRequests.filter((item) => item.status === 'failed').length ?? 0;

  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) dispatch(reorderGates({ activeId: String(event.active.id), overId: String(event.over.id) }));
  }

  function submitChange() {
    const parsed = changeSchema.safeParse({ toVersion, reason });
    if (!parsed.success || !changeFor) return;
    dispatch(requestVersionChange({ repository: changeFor.repository, toVersion: parsed.data.toVersion, reason: parsed.data.reason }));
    setChangeFor(null);
    setToVersion('');
    setReason('');
  }

  if (!train) return null;
  return (
    <main className="shell">
      <header className="hero">
        <div><Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text><Title order={1}>开源项目发布列车准备台</Title><Text>冻结时留痕每个仓库的版本与交付；换版按门禁、依赖和交付情况分流，受牵连下游重新确认，失败可重试。</Text></div>
        <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
      </header>

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder><Text size="xs">门禁通过</Text><Title order={3}>{confirmed}/{train.gates.length}</Title><Progress mt="sm" value={confirmed / Math.max(train.gates.length, 1) * 100} /></Card>
        <Card withBorder><Text size="xs">未关闭阻断项</Text><Title order={3} c={unresolved ? 'red' : 'green'}>{unresolved}</Title></Card>
        <Card withBorder><Text size="xs">远端检查</Text><Title order={3}>{health?.ready ? '可达' : '等待'}</Title></Card>
      </SimpleGrid>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md"><Title order={3}>跨仓库依赖门禁</Title><Text size="sm" c="dimmed">未交付可直接换版；已交付且被引用则新版本排下一批</Text></Group>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={train.gates.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack>{train.gates.map((gate) => <SortableGate key={gate.id} gate={gate} onConfirm={() => dispatch(confirmGate(gate.id))} onChangeRequest={() => setChangeFor(gate)} />)}</Stack>
              </SortableContext>
            </DndContext>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => <Group key={item.id} justify="space-between" className="row"><div><Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge><Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text></div><Button variant="subtle" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button></Group>)}
          </Card>

          <Card withBorder>
            <Group justify="space-between" mb="md">
              <Title order={3}>变更申请队列</Title>
              <Group>
                <Button size="xs" disabled={queuedCount === 0} onClick={() => dispatch(processChangeQueue())}>处理队列{queuedCount ? `（${queuedCount}）` : ''}</Button>
                <Button size="xs" color="red" variant="light" disabled={failedCount === 0} onClick={() => dispatch(retryFailedChanges())}>重试失败项{failedCount ? `（${failedCount}）` : ''}</Button>
              </Group>
            </Group>
            {train.changeRequests.length === 0
              ? <Text size="sm" c="dimmed">冻结后某个仓库要换版本时，在门禁卡片上申请换版；同一仓库已有变更在办时，新申请会收到冲突提示。</Text>
              : <Stack gap="xs">{train.changeRequests.map((req) => {
                const meta = changeStatusMeta[req.status];
                return (
                  <Card key={req.id} withBorder padding="sm">
                    <Group justify="space-between">
                      <Group gap="xs">
                        <Badge color={meta.color}>{meta.label}</Badge>
                        <Text size="sm" fw={600}>{req.repository}</Text>
                        <Text size="sm" c="dimmed">{req.fromVersion} → {req.toVersion}{req.batch ? ` · ${req.batch}` : ''}</Text>
                      </Group>
                      <Text size="xs" c="dimmed">{req.updatedAt}</Text>
                    </Group>
                    <Text size="xs" c="dimmed" mt={4}>原因：{req.reason}</Text>
                    {req.status === 'conflict' && <Text size="xs" c="orange" mt={4}>冲突：该仓库已有变更在办（{req.refId}），本申请未进入队列</Text>}
                    {req.status === 'failed' && <Text size="xs" c="red" mt={4}>失败：{req.error}（已完成仓库已保留，可点“重试失败项”）</Text>}
                  </Card>
                );
              })}</Stack>}
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3}>发布控制</Title>
            <Text size="sm" c="dimmed" mb="md">冻结会写下每个仓库的版本与交付情况；之后换版不再需要整条列车回滚。</Text>
            <Group><Button onClick={() => dispatch(freezeTrain())}>冻结列车</Button><Button color="red" variant="light" onClick={() => dispatch(setFreeze('rolled-back'))}>标记回滚</Button><Button variant="default" onClick={() => dispatch(setFreeze('preparing'))}>回到准备</Button></Group>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">冻结记录</Title>
            {train.freezeSnapshots.length === 0
              ? <Text size="sm" c="dimmed">冻结后在此留痕每个仓库的版本、交付情况与下游引用。</Text>
              : <Stack gap="sm">{train.freezeSnapshots.map((snap) => (
                <Card key={snap.frozenAt} withBorder padding="sm">
                  <Text size="sm" fw={700} mb={4}>{snap.frozenAt}</Text>
                  {snap.gates.map((g) => (
                    <div key={g.gateId} className="snapshot-row">
                      <Text size="sm">{g.repository} · {g.version} · <Text span c={g.delivery === 'delivered' ? 'teal' : 'gray'}>{g.delivery === 'delivered' ? '已交付' : '未交付'}</Text></Text>
                      <Text size="xs" c="dimmed">引用方：{g.referencedBy.length ? g.referencedBy.join('、') : '无'}</Text>
                    </div>
                  ))}
                </Card>
              ))}</Stack>}
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form onSubmit={form.handleSubmit((values) => { dispatch(createTrain(values)); form.reset(); })}>
              <Stack>
                <TextInput label="列车名称" {...form.register('name')} error={form.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...form.register('freezeAt')} error={form.formState.errors.freezeAt?.message} />
                <Button type="submit">创建并切换</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">审计历史</Title>
            <Stack gap="xs">{train.audit.slice(0, 8).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">其他列车</Title>
            {state.trains.map((item) => <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>{item.name}</Button>)}
          </Card>
        </Stack>
      </div>

      <Modal opened={!!changeFor} onClose={() => setChangeFor(null)} title={`申请换版 · ${changeFor?.repository ?? ''}`} centered>
        <Stack>
          <Text size="sm" c="dimmed">
            当前版本 {changeFor?.version} · {changeFor?.delivery === 'delivered' ? '已交付' : '未交付'} · {changeFor?.batch}
            {changeFor?.delivery === 'delivered' ? '；已交付且被引用时，新版本将排入下一批，不回退旧版本' : '；未交付可直接换版，受牵连下游需重新确认'}
          </Text>
          <TextInput label="目标版本" value={toVersion} onChange={(e) => setToVersion(e.currentTarget.value)} placeholder="例如 2.13.0" />
          <Textarea label="变更原因" value={reason} onChange={(e) => setReason(e.currentTarget.value)} placeholder="冻结后必须换版的原因" />
          <Button onClick={submitChange}>提交申请</Button>
        </Stack>
      </Modal>
    </main>
  );
}

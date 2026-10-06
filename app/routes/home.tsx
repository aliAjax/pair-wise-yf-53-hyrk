import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Badge, Button, Card, Group, NativeSelect, Progress, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain, confirmGate, createTrain, processChange, reorderGates, requestChange,
  resolveBlocker, setFreeze, toggleDelivered, useGetTrainHealthQuery,
  type ChangeRequest, type RepositoryGate, type RootState
} from '../store';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

const changeSchema = z.object({
  gateId: z.string().min(1, '请选择仓库'),
  toVersion: z.string().min(1, '请填写目标版本'),
  reason: z.string().min(2, '请填写变更原因')
});

function SortableGate({ gate, onConfirm, onToggleDelivered }: { gate: RepositoryGate; onConfirm: () => void; onToggleDelivered: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: gate.id });
  return (
    <Card ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={700}>{gate.repository}</Text>
          <Text size="sm" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency} · 版本 {gate.version}</Text>
        </div>
        <Group gap="xs">
          <Badge color={gate.status === 'confirmed' ? 'green' : gate.status === 'blocked' ? 'red' : 'yellow'}>{gate.status}</Badge>
          <Badge variant="light" color={gate.delivered ? 'teal' : 'gray'}>{gate.delivered ? '已交付' : '未交付'}</Badge>
          <Button size="xs" variant="light" onClick={onConfirm} disabled={gate.status === 'confirmed'}>确认门禁</Button>
          <Button size="xs" variant="default" onClick={onToggleDelivered}>{gate.delivered ? '取消交付' : '标记交付'}</Button>
          <Button size="xs" variant="subtle" {...attributes} {...listeners}>拖拽排序</Button>
        </Group>
      </Group>
    </Card>
  );
}

function ChangeCard({ change, onProcess }: { change: ChangeRequest; onProcess: () => void }) {
  const statusMeta = {
    pending: { color: 'yellow', label: '待处理' },
    done: { color: 'green', label: '已完成' },
    failed: { color: 'red', label: '部分失败' },
    conflict: { color: 'gray', label: '冲突驳回' }
  }[change.status];
  return (
    <Card withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={700}>{change.repository} · {change.fromVersion} → {change.toVersion}</Text>
          <Text size="sm" c="dimmed">{change.reason} · 提交于 {change.createdAt}</Text>
        </div>
        <Group gap="xs">
          <Badge color={change.kind === 'swap' ? 'blue' : 'violet'}>{change.kind === 'swap' ? '直接换版' : '补入下一批'}</Badge>
          <Badge color={statusMeta.color}>{statusMeta.label}</Badge>
          {(change.status === 'pending' || change.status === 'failed') && (
            <Button size="xs" variant="light" color={change.status === 'failed' ? 'orange' : 'blue'} onClick={onProcess}>
              {change.status === 'failed' ? '重试未完成仓库' : '处理变更'}
            </Button>
          )}
        </Group>
      </Group>
      {change.status === 'conflict' && (
        <Alert mt="sm" color="red" title="冲突提示">该仓库已有变更在办，本次申请未受理，请等在办变更完成或重试结束后再提交。</Alert>
      )}
      {change.steps.length > 0 && (
        <Stack gap={4} mt="sm">
          {change.steps.map((step) => (
            <Group key={step.id} justify="space-between">
              <Text size="sm">{step.repository} · {step.note}</Text>
              <Badge size="sm" variant="light" color={step.status === 'done' ? 'green' : step.status === 'failed' ? 'red' : 'gray'}>
                {step.status === 'done' ? '已完成' : step.status === 'failed' ? '失败待重试' : '待处理'}
              </Badge>
            </Group>
          ))}
        </Stack>
      )}
    </Card>
  );
}

export default function Home() {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];
  const { data: health } = useGetTrainHealthQuery(train?.id ?? 'offline');
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });
  const changeForm = useForm<z.infer<typeof changeSchema>>({ resolver: zodResolver(changeSchema), defaultValues: { gateId: '', toVersion: '', reason: '' } });
  const unresolved = train?.blockers.filter((item) => !item.resolved).length ?? 0;
  const confirmed = train?.gates.filter((item) => item.status === 'confirmed').length ?? 0;
  const inflight = train?.changes.filter((item) => item.status === 'pending' || item.status === 'failed').length ?? 0;

  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) dispatch(reorderGates({ activeId: String(event.active.id), overId: String(event.over.id) }));
  }

  if (!train) return null;
  return (
    <main className="shell">
      <header className="hero">
        <div><Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text><Title order={1}>开源项目发布列车准备台</Title><Text>跨仓库版本、依赖、阻断项和门禁确认集中处理。冻结后的版本调整走变更单，不再整列回滚。</Text></div>
        <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
      </header>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder><Text size="xs">门禁通过</Text><Title order={3}>{confirmed}/{train.gates.length}</Title><Progress mt="sm" value={confirmed / Math.max(train.gates.length, 1) * 100} /></Card>
        <Card withBorder><Text size="xs">未关闭阻断项</Text><Title order={3} c={unresolved ? 'red' : 'green'}>{unresolved}</Title></Card>
        <Card withBorder><Text size="xs">在办变更</Text><Title order={3} c={inflight ? 'orange' : 'green'}>{inflight}</Title></Card>
        <Card withBorder><Text size="xs">远端检查</Text><Title order={3}>{health?.ready ? '可达' : '等待'}</Title></Card>
      </SimpleGrid>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md"><Title order={3}>跨仓库依赖门禁</Title><Text size="sm" c="dimmed">拖动调整分批发布顺序</Text></Group>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={train.gates.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack>{train.gates.map((gate) => <SortableGate key={gate.id} gate={gate} onConfirm={() => dispatch(confirmGate(gate.id))} onToggleDelivered={() => dispatch(toggleDelivered(gate.id))} />)}</Stack>
              </SortableContext>
            </DndContext>
          </Card>

          {train.freezeRecord.length > 0 && (
            <Card withBorder>
              <Title order={3} mb="md">冻结记录</Title>
              {train.freezeRecord.map((entry) => (
                <Group key={entry.gateId} justify="space-between" className="row">
                  <div>
                    <Text fw={600} component="span">{entry.repository}</Text>
                    <Text size="sm" c="dimmed">冻结版本 {entry.version} · 记录于 {entry.at}</Text>
                  </div>
                  <Group gap="xs">
                    <Badge color={entry.delivered ? 'teal' : 'gray'}>{entry.delivered ? '已交付' : '未交付'}</Badge>
                    <Badge variant="light" color={entry.referenced ? 'violet' : 'gray'}>{entry.referenced ? '被下游引用' : '无下游引用'}</Badge>
                  </Group>
                </Group>
              ))}
            </Card>
          )}

          {(train.status === 'frozen' || train.changes.length > 0) && (
            <Card withBorder>
              <Title order={3} mb="md">冻结后变更处理</Title>
              {train.status === 'frozen' ? (
                <form onSubmit={changeForm.handleSubmit((values) => { dispatch(requestChange(values)); changeForm.reset(); })}>
                  <Stack mb="md">
                    <NativeSelect
                      label="仓库"
                      data={[{ value: '', label: '选择仓库' }, ...train.gates.map((gate) => ({ value: gate.id, label: `${gate.repository}（当前 ${gate.version}）` }))]}
                      {...changeForm.register('gateId')}
                      error={changeForm.formState.errors.gateId?.message}
                    />
                    <Group grow>
                      <TextInput label="目标版本" placeholder="例如 2.13.0" {...changeForm.register('toVersion')} error={changeForm.formState.errors.toVersion?.message} />
                      <TextInput label="变更原因" {...changeForm.register('reason')} error={changeForm.formState.errors.reason?.message} />
                    </Group>
                    <Button type="submit">提交变更申请</Button>
                  </Stack>
                </form>
              ) : (
                <Text size="sm" c="dimmed" mb="md">列车冻结后才能提交新的版本变更。</Text>
              )}
              <Stack>
                {train.changes.map((change) => <ChangeCard key={change.id} change={change} onProcess={() => dispatch(processChange(change.id))} />)}
                {train.changes.length === 0 && <Text size="sm" c="dimmed">暂无变更单。</Text>}
              </Stack>
            </Card>
          )}

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => (
              <Group key={item.id} justify="space-between" className="row">
                <div>
                  <Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge>
                  {item.repository && <Badge variant="outline" ml="xs">{item.repository}</Badge>}
                  <Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text>
                </div>
                <Button variant="subtle" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button>
              </Group>
            ))}
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3}>发布控制</Title>
            <Text size="sm" c="dimmed" mb="md">冻结时记录每个仓库的版本与交付快照；冻结后的版本调整走变更单，已交付且被引用的仓库补入下一批。</Text>
            <Group><Button onClick={() => dispatch(setFreeze('frozen'))}>冻结列车</Button><Button variant="default" onClick={() => dispatch(setFreeze('preparing'))}>回到准备</Button></Group>
          </Card>

          {train.nextBatch.length > 0 && (
            <Card withBorder>
              <Title order={3} mb="md">下一批发车计划</Title>
              <Stack gap="xs">
                {train.nextBatch.map((item) => (
                  <Group key={item.id} justify="space-between" className="row">
                    <Text size="sm"><b>{item.repository}</b> 补录版本 {item.version}</Text>
                    <Text size="xs" c="dimmed">变更单 {item.changeId} · {item.at}</Text>
                  </Group>
                ))}
              </Stack>
            </Card>
          )}

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
            <Stack gap="xs">{train.audit.slice(0, 10).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">其他列车</Title>
            {state.trains.map((item) => <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>{item.name}</Button>)}
          </Card>
        </Stack>
      </div>
    </main>
  );
}

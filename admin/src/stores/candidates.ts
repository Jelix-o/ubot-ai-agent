import { defineStore } from "pinia";
import { computed, reactive, shallowRef } from "vue";

import { api, queryString, type BulkApproveResult, type Candidate, type CandidateListResponse, type CandidateStatus, type CandidateStatusCounts, type MemoryType, type Pagination } from "../services/api";

export const useCandidatesStore = defineStore("candidates", () => {
  const items = shallowRef<Candidate[]>([]);
  const pagination = reactive<Pagination>({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const statusCounts = reactive<CandidateStatusCounts>({ pending: 0, approved: 0, rejected: 0 });
  const selectedIds = shallowRef<Set<string>>(new Set());
  const loading = shallowRef(false);
  const bulkApproving = shallowRef(false);
  const filters = reactive({
    status: "pending" as CandidateStatus | "",
    type: "" as MemoryType | "",
    q: "",
    subjectUserId: "",
  });

  const selectedCount = computed(() => selectedIds.value.size);
  const pendingItems = computed(() => items.value.filter((item) => item.status === "pending"));
  const allPageSelected = computed(() => pendingItems.value.length > 0 && pendingItems.value.every((item) => selectedIds.value.has(item.id)));

  async function load(groupId: string): Promise<void> {
    loading.value = true;
    try {
      const data = await api<CandidateListResponse>(`/api/memory-candidates${queryString({
        groupId,
        status: filters.status,
        type: filters.type,
        q: filters.q,
        subjectUserId: filters.subjectUserId,
        evidence: "preview",
        page: pagination.page,
        pageSize: pagination.pageSize,
      })}`);
      items.value = data.candidates;
      Object.assign(pagination, data.pagination);
      Object.assign(statusCounts, data.statusCounts || { pending: 0, approved: 0, rejected: 0 });
      selectedIds.value = new Set([...selectedIds.value].filter((id) => data.candidates.some((item) => item.id === id && item.status === "pending")));
    } finally {
      loading.value = false;
    }
  }

  function toggle(id: string): void {
    const item = items.value.find((entry) => entry.id === id);
    if (!item || item.status !== "pending") return;
    const next = new Set(selectedIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds.value = next;
  }

  function togglePage(): void {
    if (allPageSelected.value) {
      selectedIds.value = new Set([...selectedIds.value].filter((id) => !pendingItems.value.some((item) => item.id === id)));
      return;
    }
    selectedIds.value = new Set([...selectedIds.value, ...pendingItems.value.map((item) => item.id)]);
  }

  function clearSelection(): void {
    selectedIds.value = new Set();
  }

  async function approveSelected(): Promise<BulkApproveResult> {
    if (bulkApproving.value) {
      throw new Error("候选记忆正在入库，请稍候");
    }
    const ids = pendingItems.value.filter((item) => selectedIds.value.has(item.id)).map((item) => item.id);
    if (ids.length === 0) {
      throw new Error("请先选择待处理候选记忆");
    }
    bulkApproving.value = true;
    try {
      const result = await api<BulkApproveResult>("/api/memory-candidates/bulk-approve", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      const keep = new Set([...(result.skipped || []), ...(result.errors || [])].map((item) => item.id));
      selectedIds.value = new Set([...selectedIds.value].filter((id) => keep.has(id)));
      items.value = items.value.filter((item) => keep.has(item.id) || item.status !== "pending");
      return result;
    } finally {
      bulkApproving.value = false;
    }
  }

  return {
    items,
    pagination,
    statusCounts,
    selectedIds,
    loading,
    bulkApproving,
    filters,
    selectedCount,
    allPageSelected,
    load,
    toggle,
    togglePage,
    clearSelection,
    approveSelected,
  };
});

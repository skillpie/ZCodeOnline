// 「添加远程链接」弹窗：包一层 Dialog 的薄壳——表单草稿态在 AssistMachineAddForm
// 内部（关闭即重置），入库逻辑由父组件经 onSubmit 提供；提交/取消回调见其 props。
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { AssistMachineAddForm } from "@/AssistMachineAddForm.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function AssistMachineAddDialog({
  open,
  onOpenChange,
  localCode,
  existingCodes,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前本机码：与本机重复的码不允许再添加。 */
  localCode: string | null;
  /** 已登记的远程码集合（提交时查重）。 */
  existingCodes: readonly string[];
  /** 校验通过：code 为归一化 8 位码，name 为去除空白的可选名称。 */
  onSubmit: (code: string, name: string) => void;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="gap-4 sm:max-w-md">
        <DialogHeader className="gap-1">
          <DialogTitle className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "assistCode.dialog.add" })}
          </DialogTitle>
        </DialogHeader>
        <AssistMachineAddForm
          localCode={localCode}
          existingCodes={existingCodes}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </DialogContent>
    </Dialog>
  );
}

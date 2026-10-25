import { Button } from "antd";
import { PAGE } from "./client";

export function Pager(props: { offset: number; total: number; onChange: (offset: number) => void }) {
  if (props.total <= PAGE) return null;
  const from = props.offset + 1;
  const to = Math.min(props.offset + PAGE, props.total);
  return (
    <div className="admin-pager">
      <span className="admin-note">显示第 {from} 至 {to}，共 {props.total} 条</span>
      <div className="admin-pager-actions">
        <Button disabled={props.offset === 0} onClick={() => props.onChange(Math.max(0, props.offset - PAGE))}>上一页</Button>
        <Button disabled={props.offset + PAGE >= props.total} onClick={() => props.onChange(props.offset + PAGE)}>下一页</Button>
      </div>
    </div>
  );
}

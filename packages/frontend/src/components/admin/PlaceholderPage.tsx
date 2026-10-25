export function PlaceholderPage(props: { title: string; note: string }) {
  return (
    <div className="admin-page">
      <header className="admin-page-head">
        <div>
          <h1>{props.title} <span className="admin-soon">v1.1 未启用</span></h1>
          <p>{props.note}</p>
        </div>
      </header>
      <section className="admin-card">
        <p className="admin-empty">这一页还没有对应接口，所以不展示数据。</p>
      </section>
    </div>
  );
}

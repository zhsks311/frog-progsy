const target = "/frog-progsy/zh-cn/";

export const metadata = {
  title: "FrogProgsy",
};

export default function LegacyContributingRedirect() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
      <meta httpEquiv="refresh" content={`0; url=${target}`} />
      <h1 className="text-2xl font-semibold">正在返回文档首页</h1>
      <p className="text-fd-muted-foreground">
        贡献指南已从文档侧边栏移除。
      </p>
      <a className="text-fd-primary underline" href={target}>
        打开 FrogProgsy 简体中文文档首页
      </a>
    </main>
  );
}

const target = "/frog-progsy/ko/";

export const metadata = {
  title: "FrogProgsy",
};

export default function LegacyContributingRedirect() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
      <meta httpEquiv="refresh" content={`0; url=${target}`} />
      <h1 className="text-2xl font-semibold">문서 홈으로 이동합니다</h1>
      <p className="text-fd-muted-foreground">
        기여 문서는 문서 사이드바에서 제거되었습니다.
      </p>
      <a className="text-fd-primary underline" href={target}>
        FrogProgsy 한국어 문서 홈 열기
      </a>
    </main>
  );
}

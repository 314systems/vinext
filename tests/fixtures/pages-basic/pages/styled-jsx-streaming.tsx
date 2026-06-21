export default function StyledJsxStreamingPage() {
  return (
    <main>
      <style jsx>{`
        p {
          color: blue;
        }
      `}</style>
      <p>styled-jsx streaming parity</p>
    </main>
  );
}

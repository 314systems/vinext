type StaticGspProps = {
  message: string;
};

export function getStaticProps() {
  return {
    props: {
      message: "Hello from static GSP",
    },
  };
}

export default function StaticGsp({ message }: StaticGspProps) {
  return <p data-testid="message">{message}</p>;
}

import Header from "./components/Header";
import Hero from "./components/Hero";
import About from "./components/About";
import Experiences from "./components/Experiences";
import Rooms from "./components/Rooms";
import TaibaGuide from "./components/TaibaGuide";
import Gallery from "./components/Gallery";
import Reservation from "./components/Reservation";

function App() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <About />
        <Experiences />
        <Rooms />
        <TaibaGuide />
        <Gallery />
      </main>
      <Reservation />
    </>
  );
}

export default App;

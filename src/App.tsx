/*
 * Define la estructura general de la pagina principal.
 * Aca se decide el orden de las secciones que componen el sitio.
 * Si necesito agregar, quitar o reordenar secciones, este es el archivo.
 */

import Header from "./components/Header";
import Hero from "./components/Hero";
import About from "./components/About";
import BrandQuote from "./components/BrandQuote";
import Experiences from "./components/Experiences";
import Rooms from "./components/Rooms";
import Testimonials from "./components/Testimonials";
import TaibaGuide from "./components/TaibaGuide";
import Gallery from "./components/Gallery";
import Reservation from "./components/Reservation";
import WhatsAppFloatButton from "./components/WhatsAppFloatButton";
import CookieConsent from "./components/CookieConsent";
import { BookingDatesProvider } from "./lib/bookingDates";
import { ToastProvider } from "./lib/toast";

function App() {
  return (
    <BookingDatesProvider>
      <ToastProvider>
        <Header />
        <main>
          <Hero />
          <About />
          <BrandQuote />
          <Experiences />
          <Rooms />
          <Testimonials />
          <TaibaGuide />
          <Gallery />
        </main>
        <Reservation />
        <WhatsAppFloatButton />
        <CookieConsent />
      </ToastProvider>
    </BookingDatesProvider>
  );
}

export default App;

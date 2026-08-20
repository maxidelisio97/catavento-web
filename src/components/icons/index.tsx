/*
 * Set de icones da marca Catavento (manual, Cap. 05): line icons de trazo
 * fino, uma unica fonte de verdade para nao espalhar SVGs desenhados a mao
 * pelos componentes. Regras fixas do manual: viewBox 24x24, fill:none,
 * stroke:currentColor, stroke-width 1.5, linecap/linejoin round. Cor sempre
 * por currentColor (o container define o tom), tamanho por size/className.
 *
 * Base: Lucide via react-icons/lu (ja e dependencia transitiva do projeto,
 * usado em outros componentes com o prefixo Lu*) — o unico ajuste e o
 * stroke-width, que no Lucide vem em 2 por padrao e o manual pede 1.5.
 *
 * Preparado para crescer: o proximo lote do manual (olas, kite, vela, sol,
 * palmera) entra aqui do mesmo jeito, um wrapper por icone.
 */
import { LuWaves, LuCoffee, LuSquareParking, LuBusFront, LuBaby, LuPawPrint, LuCheck, LuX } from "react-icons/lu";
import type { IconType } from "react-icons";

const STROKE_WIDTH = 1.5;

function withThinStroke(Icon: IconType): IconType {
  return function ThinStrokeIcon(props) {
    return <Icon strokeWidth={STROKE_WIDTH} {...props} />;
  };
}

export const WavesIcon = withThinStroke(LuWaves);
export const CoffeeIcon = withThinStroke(LuCoffee);
export const ParkingIcon = withThinStroke(LuSquareParking);
export const TransferIcon = withThinStroke(LuBusFront);
export const ChildIcon = withThinStroke(LuBaby);
export const PetsIcon = withThinStroke(LuPawPrint);
export const CheckIcon = withThinStroke(LuCheck);
export const CancelIcon = withThinStroke(LuX);

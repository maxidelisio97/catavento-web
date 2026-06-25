/*
 * Reune utilidades pequenas que ayudan a escribir clases y estilos.
 * Hoy se usa para combinar clases Tailwind sin conflictos.
 * Si necesito helpers compartidos por componentes, puedo agregarlos aca.
 */

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

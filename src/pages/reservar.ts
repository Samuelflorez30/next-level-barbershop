import type { APIRoute } from 'astro';

// Destino del código QR impreso en el local. La ruta /reservar no debe cambiar
// nunca (está en material físico); si la sección de reservas se mueve, cambia
// solo el destino de esta redirección.
export const GET: APIRoute = ({ redirect }) => redirect('/#reservar', 302);

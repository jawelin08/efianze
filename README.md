# NextFinanz: control de gastos y finanzas personales

Aplicación movil, para el control de gastos y manejo de finanzas personales

## 📺 App showcase [Youtube Video](http://www.youtube.com/watch?feature=player_embedded&v=rNyuF-kUjjs)

[![showcase](https://github.com/OscarFDiaz/Flynanz_App/assets/9502714/6b23c929-b135-4660-8531-140881655b5e)](https://www.youtube.com/watch?v=rNyuF-kUjjs)

<img
src="https://i.imgur.com/Nh4Z7Lm.png"
alt="Inicio"
width="300px">
<img
src="https://i.imgur.com/xysLVqV.png"
alt="Metas"
width="300px">
<img
src="https://i.imgur.com/l4GpDCI.png"
alt="Fondo"
width="300px">
<img
src="https://i.imgur.com/dVKdoty.png"
alt="Gastos"
width="300px">
<img
src="https://i.imgur.com/Z2xO5iU.png"
alt="Mi dinero"
width="300px">
<img
src="https://i.imgur.com/qVY5PMR.png"
alt="Configuracion"
width="300px">
<img
src="https://i.imgur.com/1ukTvLk.png"
alt="Tema"
width="300px">
<img
src="https://i.imgur.com/9cYse6t.png"
alt="Tema2"
 width="300px">
<img
src="https://i.imgur.com/IRN05vb.png"
alt="Showcase"
 width="600px">

# Download / Descarga

> Available on english / Disponible en español

[<img src="https://img.shields.io/badge/Google_Play-414141?style=for-the-badge&logo=Google-Play&logoColor=white" style="width:300px">](https://play.google.com/store/apps/details?id=com.oscar.diaz)

## Despliegue privado en Railway

El servidor sirve la app y una API privada para dos miembros del hogar. Los datos financieros compartidos se guardan en PostgreSQL; las contraseñas se almacenan con scrypt y las sesiones se revocan al cerrar sesión.

1. Añade un servicio PostgreSQL al proyecto de Railway y conecta su `DATABASE_URL` al servicio Node.
2. Configura las variables `ALLOWED_USERS` con los dos correos separados por comas y `SIGNUP_INVITE_CODE` con un código largo y aleatorio que compartirán en privado.
3. Despliega el servicio Node. Al arrancar, crea sus tablas; comprueba que esté disponible en `/api/health`.
4. En `www/scripts/authConfig.js`, define `window.FLYNANZ_API_BASE_URL` con la URL pública `https://...up.railway.app` antes de compilar la app Android. En la versión web servida por el mismo servicio puede dejarse vacío.
5. Cada miembro crea una cuenta con su correo autorizado y el mismo código de invitación. Usen contraseñas distintas de al menos 10 caracteres.

El código de invitación y `DATABASE_URL` son secretos: se guardan únicamente en las variables de Railway, nunca en el repositorio ni en la app. El cliente contiene solo la URL pública del API. La sincronización se realiza cada cinco segundos; los dispositivos muestran el estado compartido y avisan antes de sustituir datos locales ya existentes al incorporarse a un hogar con información. Se recomienda habilitar copias de seguridad de PostgreSQL en Railway.

Railway aloja la base de datos en la nube, no en la red doméstica. El API limita el acceso a los dos correos configurados y guarda contraseñas con scrypt; los datos financieros no tienen cifrado de extremo a extremo, por lo que quien tenga acceso administrativo a PostgreSQL podrá leerlos. No hay recuperación de contraseña por correo en este backend; si olvidan una, será necesario restablecerla manualmente en la base.

## Instalar desde el navegador

La app incluye un manifiesto PWA y un service worker para servir el shell web guardado. En Chrome o Edge, abre la URL HTTPS de Railway y usa `Instalar` cuando aparezca en NextFinanz, o la opción `Instalar aplicación` del menú del navegador. En iPhone/iPad, usa Compartir → Añadir a pantalla de inicio en Safari. El inicio de sesión y la sincronización requieren conexión con Railway; el service worker nunca guarda respuestas del API.

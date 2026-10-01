# Política de Privacidad de NextFinanz

Última actualización: 01/10/2026

## 1. Responsable y contacto

NextFinanz es una aplicación de finanzas personales desarrollada por Oscar Diaz. Para consultas sobre privacidad o solicitudes relacionadas con los datos, escribe a `finanz.application@gmail.com`.

## 2. Datos tratados

La aplicación procesa la dirección de correo electrónico, una contraseña almacenada como hash seguro, tokens de sesión y la información financiera que los usuarios introducen, como carteras, gastos, metas y ahorros. También usa un identificador aleatorio por dispositivo para coordinar la sincronización.

## 3. Finalidad y alojamiento

Estos datos se usan para iniciar sesión y mantener la información del hogar sincronizada entre los dispositivos autorizados. La base de datos MySQL se aloja en Railway y puede ser accesible para quienes administren ese proyecto. El inicio de sesión y la sincronización requieren conexión a Internet.

## 4. Acceso y proveedores

El API limita las cuentas a los correos autorizados por el administrador del hogar. Railway presta el alojamiento del servidor y la base de datos. La aplicación no usa publicidad ni analítica.

## 5. Conservación y eliminación

La opción «Borrar datos» elimina los datos financieros del hogar sincronizado. Para solicitar la eliminación de una cuenta, escribe al contacto indicado; el cierre de sesión por sí solo no elimina la cuenta ni los datos de la base.

## 6. Seguridad y límites

Las contraseñas se guardan con scrypt y las sesiones usan tokens revocables. El uso de la URL HTTPS de Railway protege el transporte. Los datos financieros no cuentan con cifrado de extremo a extremo: el administrador de MySQL puede leerlos. Mantén privados los datos de acceso y activa copias de seguridad del proyecto.

## 7. Cookies y almacenamiento local

La aplicación no utiliza cookies de seguimiento. Conserva el token de sesión y una copia de trabajo de los datos en el almacenamiento local del navegador o dispositivo. El service worker puede guardar recursos estáticos para abrir la interfaz, pero no almacena respuestas del API.

## 8. Derechos y cambios

Puedes solicitar acceso, corrección o eliminación de la información escribiendo a `finanz.application@gmail.com`. Esta política puede actualizarse cuando cambien las funciones de la aplicación; se indicará la fecha de revisión en esta página.

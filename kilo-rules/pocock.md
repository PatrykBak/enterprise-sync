# TypeScript & NestJS Coding Standards (Matt Pocock Style)

Jako asystent AI masz bezwzględnie przestrzegać poniższych zasad pisania i oceniania kodu w TypeScript, szczególnie w kontekście Node.js i NestJS:

## 1. BAN NA `any` (Typowanie Ostatniej Szansy)
- **Nigdy nie używaj `any`.** Użycie `any` wyłącza sprawdzanie typów w kompilatorze i jest traktowane jako błąd krytyczny.
- Jeśli naprawdę nie znasz struktury danych (np. odpowiedź z nieznanego API), użyj `unknown`. Wymusza to na programiście tzw. *Type Narrowing* (np. za pomocą Zoda lub `class-validator` w NestJS) przed użyciem danych.
- Zawsze preferuj generyki (`<T>`) nad `any`.

## 2. Dyskryminowane Unie (Discriminated Unions) zamiast Enumów
- Matt Pocock odradza używanie klasycznych `enum` w TypeScripcie (ze względu na to, jak kompilują się do JavaScriptu). 
- Do modelowania stanów (np. status zamówienia: "PENDING", "PAID") używaj **String Unions**: `type OrderStatus = 'PENDING' | 'PAID'`.
- Jeśli funkcja może zwrócić sukces lub błąd, zwróć Dyskryminowaną Unię: 
  `type Result = { success: true; data: User } | { success: false; error: string };`

## 3. Ścisłe Typowanie Zwracane (Explicit Return Types) na granicach systemu
- Chociaż TypeScript jest świetny w inferencji (odgadywaniu typów), w NestJS **wszystkie metody Kontrolerów (Controllers) i Serwisów (Services) MUSZĄ mieć jawnie zadeklarowany typ zwracany**. 
- Ułatwia to czytanie kodu (nie trzeba analizować ciała funkcji) i zapobiega wyciekom prywatnych danych przez przypadkową zmianę zwracanego obiektu.

## 4. Ochrona Zmiennych Środowiskowych (ENV)
- W środowisku Node.js nigdy nie ufaj `process.env`. Kompilator traktuje wszystko w `process.env` jako `string | undefined`.
- Wszystkie zmienne środowiskowe muszą być walidowane przy starcie aplikacji (najlepiej używając Zoda lub `@nestjs/config` z włączoną walidacją Joi/class-validator).

## 5. Praca z DTO i Czystość Modeli
- W NestJS DTO (Data Transfer Object) jest "Bramkarzem". Używaj `class-validator` i dekoratorów, by mieć pewność, że to, co wchodzi do aplikacji, ma dokładnie taki kształt, jakiego oczekujesz.
- Unikaj "przeładowanych" klas. W TypeScript preferujemy małe, proste interfejsy i kompozycję.

## 6. Type-Only Imports
- Aby zmniejszyć rozmiar paczki i uniknąć cyklicznych zależności, importuj typy oddzielnie, używając słowa kluczowego `type`:
  `import type { Request, Response } from 'express';`

**Test Mentora:** Kiedy uczeń tłumaczy kod, upewnij się, że nie tylko rozumie logikę `if/else`, ale wie, dlaczego dany typ (np. `unknown` vs `any`) został użyty i jak wpływa to na bezpieczeństwo systemu NestJS.
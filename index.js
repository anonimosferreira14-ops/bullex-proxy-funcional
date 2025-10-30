import { useState, useEffect, useRef } from 'react';
import { useToast } from '@/hooks/use-toast';
import { io, Socket } from 'socket.io-client';

const PROXY_URL = "https://bullex-proxy-funcional.onrender.com";

interface PressureData {
  call: number[];
  put: number[];
  asset_id: number;
  timestamp: number;
}

interface Position {
  id: string;
  direction: 'call' | 'put';
  invest: number;
  open_price: number;
  current_price: number;
  pnl: number;
  status: 'open' | 'closed';
}

interface CandleData {
  timeframe: number;
  open: number;
  high: number;
  low: number;
  close: number;
  from: number;
  to: number;
}

export const useBullExWebSocket = (ssid: string | null, accountType: 'real' | 'demo' = 'demo') => {
  const { toast } = useToast();
  const [isConnected, setIsConnected] = useState(false);
  const [pressureData, setPressureData] = useState<PressureData | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [candles, setCandles] = useState<Record<number, CandleData>>({});
  const [balance, setBalance] = useState(0);
  const [userProfile, setUserProfile] = useState<any>(null);
  
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!ssid) {
      console.log('⏸️ Aguardando SSID para conectar...');
      return;
    }

    console.log('🔗 SSID RECEBIDO! Iniciando conexão ao Proxy Render...');
    console.log('📍 URL do Proxy:', PROXY_URL);
    console.log('🔑 SSID a ser enviado:', ssid.substring(0, 15) + '...');
    console.log('🔑 Tamanho do SSID:', ssid.length, 'caracteres');
    
    const socket = io(PROXY_URL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionAttempts: Infinity,
      timeout: 20000,
      forceNew: true
    });
    
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('🔗 Conectado ao Proxy Render - Socket ID:', socket.id);
      console.log('📤 Enviando authenticate com SSID e tipo de conta...');
      console.log('🔑 SSID:', ssid.substring(0, 15) + '...');
      console.log('💼 Tipo de conta:', accountType.toUpperCase());
      socket.emit('authenticate', { ssid, accountType });
    });

    // 🔴 DEBUG: Ver TODOS os eventos que chegam
    socket.onAny((eventName: string, ...args: any[]) => {
      console.error(`🔴 [TODOS OS EVENTOS] Recebido: ${eventName}`, args);
    });

    socket.on('authenticated', (data: any) => {
      console.error("🔴 [AUTHENTICATED] Dados:", data);
      console.log('🎯 Sessão BullEx autenticada com sucesso!', data);
      setIsConnected(true);
      
      toast({
        title: "🎯 Conectado à BullEx",
        description: "Autenticado com sucesso via Proxy Render",
      });
      
      console.log('📥 Solicitando perfil do usuário...');
      requestProfile();
      console.log('📡 Inscrevendo em canais de dados...');
      subscribeToChannels();
    });

    socket.on("front", (data: any) => {
      console.error("🔴 [FRONT] Dados:", data);
    });

    // ===== BALANCE CORRIGIDO! =====
    socket.on("balance", (data: any) => {
      console.log("💰 balance recebido:", data);
      
      // Formato 1: { msg: { current_balance: { amount: X } } }
      if (data.msg?.current_balance?.amount) {
        const amount = data.msg.current_balance.amount / 100;
        setBalance(amount);
        
        if (data.msg.current_balance.id) {
          setUserProfile((prev: any) => ({ 
            ...prev, 
            balance_id: data.msg.current_balance.id 
          }));
        }
        
        console.log(`💰 Saldo: $${amount.toFixed(2)}`);
        toast({
          title: "✅ Conectado!",
          description: `Saldo sincronizado: $${amount.toFixed(2)}`,
        });
        return;
      }
      
      // Formato 2: [ { id: X, amount: Y, currency: "USD" } ]
      if (Array.isArray(data.msg)) {
        const usdBalance = data.msg.find((b: any) => b.currency === 'USD');
        if (usdBalance) {
          setBalance(usdBalance.amount);
          setUserProfile((prev: any) => ({ 
            ...prev, 
            balance_id: usdBalance.id 
          }));
          console.log(`💰 Saldo: $${usdBalance.amount.toFixed(2)}`);
        }
        return;
      }

      // Formato 3: { amount: X }
      if (data.amount !== undefined) {
        setBalance(data.amount / 100);
        console.log(`💰 Saldo: $${(data.amount / 100).toFixed(2)}`);
      }
    });

    // Captura todas as mensagens BullEx repassadas pelo proxy
    socket.on('bullex_message', (msg: any) => {
      console.log('📡 [BULLEX_MESSAGE]', msg?.name || 'sem nome');

      // Fallback caso BullEx envie authenticated dentro de bullex_message
      if (msg?.name === 'authenticated') {
        console.log('🎯 Autenticação confirmada via bullex_message');
        setIsConnected(true);
        toast({
          title: "🎯 Conectado à BullEx",
          description: "Sessão autenticada (via bullex_message)",
        });
      }

      // Rotear mensagens para handlers apropriados
      switch (msg?.name) {
        case 'profile':
          handleProfile(msg);
          break;
        case 'client-buyback-generated':
          handlePressure(msg);
          break;
        case 'candles-generated':
        case 'candles':
          handleCandles(msg);
          break;
        case 'positions-state':
        case 'positions':
          handlePositionsState(msg);
          break;
        case 'position-changed':
          handlePositionChanged(msg);
          break;
        case 'balance-changed':
          handleBalanceChanged(msg);
          break;
      }
    });

    socket.on('unauthorized', (data: any) => {
      console.error('🚫 SSID inválido ou expirado:', data);
      setIsConnected(false);
      toast({
        title: "🚫 SSID inválido",
        description: "Sessão expirada. Faça login novamente.",
        variant: "destructive",
      });
    });

    socket.on('disconnect', (reason: string) => {
      console.warn('🔴 Desconectado do Proxy Render. Motivo:', reason);
      setIsConnected(false);
      toast({
        title: "🔴 Desconectado",
        description: `Conexão perdida: ${reason}`,
        variant: "destructive",
      });
    });

    socket.on('connect_error', (error: any) => {
      console.error('🚫 Erro de conexão ao Proxy Render:', error?.message || error);
      setIsConnected(false);
      toast({
        title: "🚫 Falha na conexão",
        description: "Não foi possível conectar ao Proxy Render",
        variant: "destructive",
      });
    });

    socket.on('error', (error: any) => {
      console.error('🔴 [SOCKET ERROR]', error);
      console.error('⚠️ Erro no socket:', error?.message || error);
      setIsConnected(false);
      toast({
        title: "⚠️ Erro no canal",
        description: "Erro na comunicação com o Proxy Render",
        variant: "destructive",
      });
    });

    // Listen to all message types from BullEx via Proxy
    socket.on('profile', (data: any) => {
      console.log('👤 Perfil recebido do Proxy:', data);
      handleProfile(data);
    });
    
    socket.on('client-buyback-generated', (data: any) => {
      console.log('📊 Pressão recebida do Proxy');
      handlePressure(data);
    });
    
    socket.on('candles-generated', (data: any) => {
      console.log('🕯️ Candles recebidos do Proxy');
      handleCandles(data);
    });
    
    socket.on('candles', (data: any) => {
      console.log('🕯️ Candles (alternativo) recebidos do Proxy');
      handleCandles(data);
    });
    
    socket.on('positions-state', (data: any) => {
      console.log('📍 Posições recebidas do Proxy');
      handlePositionsState(data);
    });
    
    socket.on('positions', (data: any) => {
      console.log('📍 Posições (alternativo) recebidas do Proxy');
      handlePositionsState(data);
    });
    
    socket.on('position-changed', (data: any) => {
      console.log('🔄 Mudança de posição via Proxy:', data.status);
      handlePositionChanged(data);
    });
    
    socket.on('balance-changed', (data: any) => {
      console.log('💰 Saldo alterado via Proxy');
      handleBalanceChanged(data);
    });

    return () => {
      if (socketRef.current) {
        console.log('🔌 Desconectando socket...');
        socketRef.current.disconnect();
      }
    };
  }, [ssid, accountType]);

  const requestProfile = () => {
    socketRef.current?.emit('sendMessage', {
      name: 'sendMessage',
      msg: {
        name: 'balances.get-balances',
        version: '1.0',
        body: {}
      }
    });
  };

  const subscribeToChannels = () => {
    const currentAssetId = 76; // EURUSD-OTC

    // Subscribe pressão
    socketRef.current?.emit('subscribeMessage', {
      name: 'subscribeMessage',
      msg: {
        name: 'price-splitter.client-buyback-generated',
        version: '1.0',
        params: {
          routingFilters: {
            asset_id: currentAssetId,
            instrument_type: 'turbo-option',
            user_group_id: 274
          }
        }
      }
    });

    // ===== SUBSCRIBE CANDLES CORRIGIDO! =====
    socketRef.current?.emit('subscribeMessage', {
      name: 'subscribeMessage',
      msg: {
        name: 'candles-generated',
        version: '1.0',
        params: {
          routingFilters: {
            active_id: currentAssetId
          }
        }
      }
    });

    // Subscribe posições
    socketRef.current?.emit('sendMessage', {
      name: 'sendMessage',
      msg: {
        name: 'subscribe-positions',
        version: '1.0',
        body: {
          frequency: 'frequent',
          ids: []
        }
      }
    });

    console.log('✅ Canais assinados (Pressão + Candles + Posições)');
  };

  const handleProfile = (data: any) => {
    const profile = data.msg?.result || data.result || data;
    const accountType = profile.demo === 1 ? 'DEMO' : 'REAL';
    
    setUserProfile({
      id: profile.user_id,
      email: profile.email,
      name: profile.name,
      balance: (profile.balance || 0) / 100,
      currency: profile.currency,
      balance_id: profile.balance_id,
      accountType: accountType,
      demo: profile.demo
    });
    
    if (profile.balance) {
      setBalance(profile.balance / 100);
    }
    
    console.log(`👤 Perfil carregado - Conta: ${accountType}`);
    console.log(`💰 Saldo ${accountType}: $${((profile.balance || 0) / 100).toFixed(2)}`);
    
    toast({
      title: `Perfil carregado - Conta ${accountType}`,
      description: `Bem-vindo, ${profile.first_name || profile.name}! Saldo: $${((profile.balance || 0) / 100).toFixed(2)}`,
    });
  };

  const handlePressure = (data: any) => {
    const msgData = data.msg || data;
    
    setPressureData({
      call: msgData.call,
      put: msgData.put,
      asset_id: msgData.asset_id,
      timestamp: Date.now()
    });
  };

  const handleCandles = (data: any) => {
    const msgData = data.msg || data;
    const candlesData = msgData.candles;
    
    if (!candlesData) return;
    
    const updatedCandles: Record<number, CandleData> = {};
    
    Object.keys(candlesData).forEach(tf => {
      const timeframe = parseInt(tf);
      const candle = candlesData[tf];
      updatedCandles[timeframe] = {
        timeframe,
        open: candle.open,
        high: candle.max,
        low: candle.min,
        close: msgData.value || candle.close,
        from: candle.from,
        to: candle.to
      };
    });
    
    setCandles(updatedCandles);
    console.log('🕯️ Candles atualizados:', Object.keys(updatedCandles).length, 'timeframes');
  };

  const handlePositionsState = (data: any) => {
    const msgData = data.msg || data;
    if (!msgData.positions) return;
    
    const updatedPositions = msgData.positions.map((pos: any) => ({
      id: pos.id,
      direction: pos.direction as 'call' | 'put',
      invest: pos.margin || pos.invest,
      open_price: pos.open_price,
      current_price: pos.current_price,
      pnl: pos.pnl,
      status: 'open' as const
    }));
    setPositions(updatedPositions);
  };

  const handlePositionChanged = (data: any) => {
    const msgData = data.msg || data;
    if (msgData.status !== 'closed') return;
    
    const result = msgData.close_reason;
    const pnl = msgData.pnl_realized / 100;
    const direction = msgData.raw_event?.binary_options_option_changed1?.direction || 'unknown';
    
    console.log(`${result === 'win' ? '✅ WIN' : '❌ LOSS'}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD`);
    
    // Adicionar ao histórico
    if ((window as any).tradingHistory) {
      (window as any).tradingHistory.push({
        result: result === 'win' ? 'WIN' : 'LOSS',
        profit: pnl,
        direction: direction,
        timestamp: Date.now()
      });
    }
    
    toast({
      title: result === 'win' ? '🎉 WIN!' : '❌ LOSS',
      description: `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
      variant: result === 'win' ? 'default' : 'destructive',
    });
    
    setPositions(prev => prev.filter(p => p.id !== msgData.id));
  };

  // ===== BALANCE CHANGE CORRIGIDO! =====
  const handleBalanceChanged = (data: any) => {
    const msgData = data.msg || data;
    
    if (msgData.current_balance?.amount) {
      const newBalance = msgData.current_balance.amount / 100;
      setBalance(newBalance);
      console.log(`💰 Saldo atualizado: $${newBalance.toFixed(2)}`);
    }
  };

  // ===== OPEN POSITION CORRIGIDO! =====
  const openPosition = (direction: 'call' | 'put', amount: number, assetId: number = 76, duration: number = 60) => {
    if (!isConnected || !socketRef.current) {
      toast({
        title: "❌ Não conectado",
        description: "Conecte-se primeiro para operar",
        variant: "destructive",
      });
      return;
    }

    if (!userProfile?.balance_id) {
      toast({
        title: "❌ Balance ID não disponível",
        description: "Aguarde o carregamento do perfil",
        variant: "destructive",
      });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const expiration = now + duration;
    const valueInCents = Math.floor(amount * 100);

    console.log('📤 Enviando ordem:', {
      direction,
      amount,
      assetId,
      duration,
      balance_id: userProfile.balance_id
    });

    // FORMATO CORRETO DA BULLEX
    socketRef.current.emit('sendMessage', {
      name: 'sendMessage',
      msg: {
        name: 'binary-options.open-option',
        version: '2.0',
        body: {
          user_balance_id: userProfile.balance_id,
          active_id: assetId,
          option_type_id: 3, // turbo-option
          direction: direction,
          expired: expiration,
          price: 1,
          profit_percent: 87,
          refund_value: 0,
          value: valueInCents
        }
      }
    });

    console.log(`📤 Ordem ${direction.toUpperCase()} enviada: $${amount} - Ativo: ${assetId}`);
    
    toast({
      title: `${direction === 'call' ? '🟢' : '🔴'} Operação ${direction.toUpperCase()} enviada`,
      description: `Valor: $${amount} | Duração: ${duration}s`,
    });
  };

  return {
    isConnected,
    pressureData,
    positions,
    candles,
    balance,
    userProfile,
    openPosition
  };
};

// Adicionar log para debug
if (typeof window !== 'undefined') {
  (window as any).checkConnectionState = () => {
    console.log('🔍 Estado atual de conexão disponível através do hook');
  };
}
